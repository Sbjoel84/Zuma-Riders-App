import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common";
import { normalizeNigerianPhone } from "@zuma/contracts";
import type { Response } from "express";
import { randomBytes } from "crypto";
import { z } from "zod";
import { fail } from "../../common/errors";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { env } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";
import { SmsService } from "../../infra/sms.service";
import { Public, Scopes } from "../auth/auth.guard";
import { AvailabilityService } from "../geo/availability.service";
import { NotificationsService, type NotificationCategory } from "../notifications/notifications.service";
import { ReferralsService } from "../promos/referrals.service";
import { PromosService } from "../promos/promos.service";
import { ACTIVE_RIDE_STATUSES } from "../rides/state-machine";
import { areaName } from "../rides/codes";

const PushBody = z.object({ token: z.string().min(10).max(300), platform: z.enum(["ANDROID", "IOS"]), installId: z.string().max(100).optional() });
const ContactBody = z.object({ name: z.string().trim().min(2).max(60), phone: z.string().min(7).max(20), relationship: z.string().trim().max(30).optional(), shareTripsAutomatically: z.boolean().optional() });
const PrefBody = z.object({ category: z.enum(["TRIP", "PAYMENT", "CHAT", "ACCOUNT", "PROMOTIONS"]), enabled: z.boolean() });
const ShareBody = z.object({ notifyContacts: z.boolean().optional() });
const PromoCheckBody = z.object({ code: z.string().trim().min(3).max(30), categoryKey: z.string().optional(), fare: z.string().regex(/^\d+$/).optional() });
const ReferralBody = z.object({ code: z.string().trim().min(4).max(20) });

const MAX_CONTACTS = 3;

/** Account-level features for both apps: push tokens, inbox, emergency contacts, referrals, trip sharing. */
@Controller("v1")
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotificationsService,
    private readonly sms: SmsService,
    private readonly referrals: ReferralsService,
    private readonly promos: PromosService,
    private readonly availability: AvailabilityService,
  ) {}

  // ---------- push + inbox ----------

  @Post("me/push-tokens")
  @HttpCode(204)
  async pushToken(@Auth() auth: AuthContext, @Body(new ZodPipe(PushBody)) body: z.infer<typeof PushBody>) {
    await this.notify.registerToken(auth.userId, body.token, body.platform, body.installId);
  }

  @Delete("me/push-tokens/:token")
  @HttpCode(204)
  async removeToken(@Auth() auth: AuthContext, @Param("token") token: string) {
    await this.notify.removeToken(auth.userId, token);
  }

  @Get("me/notifications")
  inbox(@Auth() auth: AuthContext, @Query("cursor") cursor?: string) {
    return this.notify.inbox(auth.userId, cursor);
  }

  @Post("me/notifications/read-all")
  @HttpCode(204)
  async readAll(@Auth() auth: AuthContext) {
    await this.notify.markAllRead(auth.userId);
  }

  @Get("me/notification-preferences")
  prefs(@Auth() auth: AuthContext) {
    return this.notify.preferences(auth.userId);
  }

  @Put("me/notification-preferences")
  async setPref(@Auth() auth: AuthContext, @Body(new ZodPipe(PrefBody)) body: z.infer<typeof PrefBody>) {
    await this.notify.setPreference(auth.userId, body.category as NotificationCategory, body.enabled);
    return this.notify.preferences(auth.userId);
  }

  // ---------- emergency contacts ----------

  @Get("me/emergency-contacts")
  async contacts(@Auth() auth: AuthContext) {
    const rows = await this.prisma.db.emergencyContact.findMany({ where: { userId: auth.userId, deletedAt: null }, orderBy: { createdAt: "asc" } });
    return rows.map((c) => ({ id: c.id, name: c.name, phone: c.phoneE164, relationship: c.relationship, shareTripsAutomatically: c.shareTripsAutomatically }));
  }

  @Post("me/emergency-contacts")
  async addContact(@Auth() auth: AuthContext, @Body(new ZodPipe(ContactBody)) body: z.infer<typeof ContactBody>) {
    const phone = normalizeNigerianPhone(body.phone) ?? fail("VALIDATION_FAILED", "Enter a valid phone number, e.g. 0803 123 4567");
    const me = await this.prisma.db.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (me.phoneE164 === phone) fail("VALIDATION_FAILED", "Add someone else's number");
    const existing = await this.prisma.db.emergencyContact.findMany({ where: { userId: auth.userId, deletedAt: null } });
    if (existing.some((c) => c.phoneE164 === phone)) fail("VALIDATION_FAILED", "That contact is already saved");
    if (existing.length >= MAX_CONTACTS) fail("VALIDATION_FAILED", `You can save up to ${MAX_CONTACTS} emergency contacts`);
    await this.prisma.db.emergencyContact.create({ data: { userId: auth.userId, name: body.name, phoneE164: phone, relationship: body.relationship, shareTripsAutomatically: body.shareTripsAutomatically ?? false } });
    return this.contacts(auth);
  }

  @Delete("me/emergency-contacts/:id")
  async removeContact(@Auth() auth: AuthContext, @Param("id") id: string) {
    await this.prisma.db.emergencyContact.updateMany({ where: { id, userId: auth.userId, deletedAt: null }, data: { deletedAt: new Date() } });
    return this.contacts(auth);
  }

  // ---------- referrals + promos ----------

  @Scopes("PASSENGER", "DRIVER")
  @Get("me/referrals")
  referralSummary(@Auth() auth: AuthContext) {
    return this.referrals.summary(auth.userId, auth.scope === "DRIVER" ? "DRIVER" : "PASSENGER");
  }

  /** Enter a friend's code after sign-up (within 7 days and before the first trip). */
  @Scopes("PASSENGER", "DRIVER")
  @Post("me/referral")
  async applyReferral(@Auth() auth: AuthContext, @Body(new ZodPipe(ReferralBody)) body: { code: string }) {
    const me = await this.prisma.db.user.findUniqueOrThrow({ where: { id: auth.userId }, include: { passengerProfile: true, driver: true } });
    if (await this.prisma.db.referral.findUnique({ where: { refereeId: auth.userId } })) fail("VALIDATION_FAILED", "You've already used a referral code");
    const trips = auth.scope === "DRIVER" ? (me.driver?.tripsCompleted ?? 0) : (me.passengerProfile?.tripsCompleted ?? 0);
    if (trips > 0 || me.createdAt < new Date(Date.now() - 7 * 86400_000)) fail("VALIDATION_FAILED", "Referral codes can only be used by new accounts");
    const referrer = await this.prisma.db.user.findUnique({ where: { referralCode: body.code.toUpperCase() } });
    if (!referrer || referrer.id === auth.userId) fail("VALIDATION_FAILED", "That referral code isn't valid");
    await this.prisma.db.referral.create({ data: { referrerId: referrer!.id, refereeId: auth.userId, refereeRole: auth.scope === "DRIVER" ? "DRIVER" : "PASSENGER" } });
    return { ok: true, referrer: referrer!.firstName };
  }

  @Scopes("PASSENGER")
  @Post("promos/check")
  @HttpCode(200)
  checkPromo(@Auth() auth: AuthContext, @Body(new ZodPipe(PromoCheckBody)) body: z.infer<typeof PromoCheckBody>) {
    return this.promos.validate(auth.userId, body.code, body.categoryKey, body.fare ? BigInt(body.fare) : undefined);
  }

  // ---------- trip sharing ----------

  /** Creates (or reuses) a live link to the trip and optionally texts it to the rider's emergency contacts. */
  @Scopes("PASSENGER")
  @Post("rides/:id/share")
  async share(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(ShareBody)) body: { notifyContacts?: boolean }) {
    const ride = await this.prisma.db.ride.findUnique({ where: { id }, include: { passenger: { include: { user: true } }, driver: { include: { user: true } }, vehicle: true } });
    if (!ride || ride.passenger.userId !== auth.userId) fail("NOT_FOUND", "Trip not found");
    if (!ACTIVE_RIDE_STATUSES.includes(ride!.status)) fail("INVALID_STATE_TRANSITION", "You can share a trip while it's in progress");
    const token = ride!.shareToken ?? randomBytes(18).toString("base64url");
    if (!ride!.shareToken) await this.prisma.db.ride.update({ where: { id }, data: { shareToken: token } });
    const url = `${env().PUBLIC_API_URL}/v1/share/${token}`;
    let notified = 0;
    if (body.notifyContacts) {
      const contacts = await this.prisma.db.emergencyContact.findMany({ where: { userId: auth.userId, deletedAt: null } });
      const me = ride!.passenger.user;
      for (const c of contacts) {
        await this.sms.send(c.phoneE164, `${me.firstName} shared a Riders App trip with you: ${ride!.vehicle.colour} ${ride!.vehicle.make} ${ride!.vehicle.model} ${ride!.vehicle.plateNumber}, driver ${ride!.driver.user.firstName}. Follow it live: ${url}`).then(() => notified++).catch(() => undefined);
      }
    }
    return { url, contactsNotified: notified };
  }

  /** Public live-trip page for people the rider shared the link with. No account needed. */
  @Public()
  @Get("share/:token")
  async sharedTrip(@Param("token") token: string, @Res() res: Response) {
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'");
    res.setHeader("Cache-Control", "no-store");
    const ride = token.length >= 16 ? await this.prisma.db.ride.findUnique({ where: { shareToken: token }, include: { passenger: { include: { user: true } }, driver: { include: { user: true } }, vehicle: true, rideRequest: true } }) : null;
    if (!ride || !ACTIVE_RIDE_STATUSES.includes(ride.status)) {
      return res.status(ride ? 200 : 404).send(sharePage("Trip ended", `<p>This trip has ended or the link is no longer active.</p>`, false));
    }
    const pos = await this.availability.position(ride.driverId);
    const status: Record<string, string> = { DRIVER_SELECTED: "Driver assigned", DRIVER_EN_ROUTE: "Driver on the way to pickup", DRIVER_ARRIVED: "Driver at pickup", TRIP_STARTED: "On the trip" };
    const where = pos ? `<a class="b" href="https://www.google.com/maps/search/?api=1&query=${pos.lat},${pos.lng}">See the car's location on a map</a><p class="muted">Location updated live. This page refreshes every 20 seconds.</p>` : `<p class="muted">Live location not available right now.</p>`;
    return res.send(sharePage(`${esc(ride.passenger.user.firstName)} is on a Riders App trip`, `
      <p class="pill">${status[ride.status] ?? ride.status}</p>
      <dl><dt>Car</dt><dd>${esc(`${ride.vehicle.colour} ${ride.vehicle.make} ${ride.vehicle.model}`)} · <b>${esc(ride.vehicle.plateNumber)}</b></dd>
      <dt>Driver</dt><dd>${esc(ride.driver.user.firstName)} · ★ ${ride.driver.ratingAvg.toString()}</dd>
      <dt>From</dt><dd>${esc(areaName(ride.rideRequest.pickupAddress))}</dd><dt>To</dt><dd>${esc(areaName(ride.rideRequest.dropoffAddress))}</dd></dl>
      ${where}<p class="muted">In an emergency call 112.</p>`, true));
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sharePage = (title: string, body: string, refresh: boolean) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="20">' : ""}<meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f5f1;margin:0;padding:16px;color:#12161b}main{max-width:440px;margin:24px auto;background:#fff;border-radius:16px;padding:22px;box-shadow:0 1px 3px #0002}
h1{font-size:21px;margin:0 0 10px}.muted{color:#5d645c;font-size:14px}.pill{display:inline-block;background:#f2a900;border-radius:99px;padding:4px 12px;font-weight:600;margin:0 0 6px}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:14px 0}dt{color:#5d645c}dd{margin:0}.b{display:block;text-align:center;text-decoration:none;padding:13px;border-radius:12px;background:#12161b;color:#fff;font-weight:600;margin-top:10px}</style>
</head><body><main><h1>${title}</h1>${body}</main></body></html>`;
