import { Injectable, OnModuleInit } from "@nestjs/common";
import type { CancelBody, EarningsView, RateBody, RideView } from "@zuma/contracts";
import { timingSafeEqual } from "crypto";
import { env } from "../../config/env";
import { DomainError, fail } from "../../common/errors";
import type { AuthContext } from "../../common/http";
import { haversineM } from "../../infra/maps.service";
import { isUniqueViolation, PrismaService } from "../../infra/prisma.service";
import { AvailabilityService } from "../geo/availability.service";
import { EventsService } from "../realtime/events.service";
import { tripPin } from "./codes";
import { JobsService } from "./jobs.service";
import { SettlementService } from "./settlement.service";
import { ACTIVE_RIDE_STATUSES, OPEN_REQUEST_STATUSES, passengerCancellationFee, transition, type Actor, type TripEvent } from "./state-machine";
import { requestInclude, requestView, rideInclude, rideView } from "./views";

const MAX_PIN_ATTEMPTS = 5;

@Injectable()
export class TripsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly events: EventsService,
    private readonly settlement: SettlementService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register("release", async (job) => {
      await this.prisma.db.$transaction((tx) => this.settlement.release(tx, job.data.rideId));
    });
  }

  private async load(rideId: string) {
    const r = await this.prisma.db.ride.findUnique({ where: { id: rideId }, include: rideInclude });
    if (!r) fail("NOT_FOUND", "Trip not found");
    return r!;
  }

  private actorFor(ride: Awaited<ReturnType<TripsService["load"]>>, auth: AuthContext): Actor {
    if (auth.scope === "ADMIN") return "ADMIN";
    if (auth.scope === "DRIVER" && ride.driver.userId === auth.userId) return "DRIVER";
    if (auth.scope === "PASSENGER" && ride.passenger.userId === auth.userId) return "PASSENGER";
    throw new DomainError("NOT_FOUND", "Trip not found");
  }

  async view(rideId: string, auth: AuthContext): Promise<RideView> {
    const r = await this.load(rideId);
    const actor = this.actorFor(r, auth);
    const pos = ACTIVE_RIDE_STATUSES.includes(r.status) ? await this.availability.position(r.driverId) : null;
    return rideView(r, actor === "SYSTEM" ? "ADMIN" : actor, pos);
  }

  /** What the app should show on launch: an active trip, an open request, or nothing. */
  async current(auth: AuthContext) {
    if (auth.scope === "PASSENGER") {
      const p = await this.prisma.db.passengerProfile.findUnique({ where: { userId: auth.userId } });
      if (!p) return { ride: null, request: null };
      const ride = await this.prisma.db.ride.findFirst({ where: { passengerId: p.id, status: { in: ACTIVE_RIDE_STATUSES } } });
      if (ride) return { ride: await this.view(ride.id, auth), request: null };
      const req = await this.prisma.db.rideRequest.findFirst({ where: { passengerId: p.id, status: { in: OPEN_REQUEST_STATUSES }, expiresAt: { gt: new Date() } }, include: requestInclude });
      return { ride: null, request: req ? requestView(req) : null };
    }
    const d = await this.prisma.db.driver.findUnique({ where: { userId: auth.userId } });
    if (!d) return { ride: null, request: null };
    const ride = await this.prisma.db.ride.findFirst({ where: { driverId: d.id, status: { in: ACTIVE_RIDE_STATUSES } } });
    return { ride: ride ? await this.view(ride.id, auth) : null, request: null };
  }

  async history(auth: AuthContext, cursor?: string, limit = 20) {
    const where =
      auth.scope === "DRIVER"
        ? { driver: { userId: auth.userId } }
        : { passenger: { userId: auth.userId } };
    const rows = await this.prisma.db.ride.findMany({ where, orderBy: { createdAt: "desc" }, include: rideInclude, take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    const page = rows.slice(0, limit);
    return { data: page.map((r) => rideView(r, auth.scope, null)), nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
  }

  async apply(rideId: string, event: TripEvent, auth: AuthContext, extra: { pin?: string; lat?: number; lng?: number; cancel?: CancelBody; expectedVersion?: number } = {}): Promise<RideView> {
    const ride = await this.load(rideId);
    const actor = this.actorFor(ride, auth);
    const t = transition(ride.status, event, actor);
    if (!t.ok) fail("INVALID_STATE_TRANSITION", t.reason === "ACTOR_NOT_ALLOWED" ? "You can't do that on this trip" : `This trip is ${ride.status.toLowerCase().replace(/_/g, " ")}`, { from: ride.status, attempted: event });
    const to = (t as { ok: true; to: typeof ride.status }).to;

    if (event === "ARRIVED") {
      const pos = await this.availability.position(ride.driverId);
      const pickup = { lat: ride.rideRequest.pickupLat, lng: ride.rideRequest.pickupLng };
      const dist = pos ? haversineM(pos, pickup) : null;
      if (dist === null || dist > env().ARRIVAL_RADIUS_M) fail("TOO_FAR_FROM_PICKUP", "You need to be at the pickup point to mark arrival", { distanceM: dist === null ? null : Math.round(dist) });
    }

    if (event === "START") {
      if (ride.pinAttempts >= MAX_PIN_ATTEMPTS) fail("PIN_ATTEMPTS_EXCEEDED", "Too many wrong PINs. Contact support to start this trip.");
      const ok = extra.pin && extra.pin.length === 4 && timingSafeEqual(Buffer.from(extra.pin), Buffer.from(tripPin(ride.id)));
      if (!ok) {
        await this.prisma.db.ride.update({ where: { id: ride.id }, data: { pinAttempts: { increment: 1 } } });
        fail("INVALID_TRIP_PIN", "That PIN is not correct. Ask the passenger for the PIN in their app.", { attemptsLeft: MAX_PIN_ATTEMPTS - ride.pinAttempts - 1 });
      }
    }

    const now = new Date();
    let settlementInfo: { switchedToCash: boolean; method: string } | null = null;
    let cancelFee = 0n;

    await this.prisma.db.$transaction(async (tx) => {
      const data: Record<string, unknown> = { status: to, version: { increment: 1 } };
      if (event === "ARRIVED") data.arrivedAt = now;
      if (event === "START") data.startedAt = now;
      if (event === "COMPLETE") {
        data.completedAt = now;
        data.actualDurationS = ride.startedAt ? Math.round((now.getTime() - ride.startedAt.getTime()) / 1000) : null;
      }
      if (event === "CANCEL") data.cancelledAt = now;

      const updated = await tx.ride.updateMany({ where: { id: ride.id, version: ride.version, status: ride.status }, data });
      if (updated.count === 0) throw new DomainError("RIDE_STATE_CHANGED", "This trip was just updated. Refresh and try again.");

      await tx.rideStatusHistory.create({
        data: { rideId: ride.id, fromStatus: ride.status, toStatus: to, actorType: actor, actorUserId: auth.userId, lat: extra.lat, lng: extra.lng, reason: extra.cancel?.reasonCode },
      });

      if (event === "COMPLETE") {
        const s = await this.settlement.settle(tx, ride.id);
        await tx.ride.update({ where: { id: ride.id }, data: { finalFare: s.finalFare, paymentMethod: s.method } });
        await tx.rideRequest.update({ where: { id: ride.rideRequestId }, data: { status: "TRIP_COMPLETED" } });
        settlementInfo = { switchedToCash: s.switchedToCash, method: s.method };
      }

      if (event === "CANCEL") {
        const cfg = await tx.pricingConfiguration.findUniqueOrThrow({ where: { id: (await tx.rideRequest.findUniqueOrThrow({ where: { id: ride.rideRequestId } })).pricingConfigId } });
        if (actor === "PASSENGER") {
          cancelFee = passengerCancellationFee({ status: ride.status, assignedAt: ride.assignedAt, now, graceSeconds: cfg.cancellationGraceSeconds, fee: cfg.cancellationFeePassenger });
        }
        await tx.rideCancellation.create({
          data: {
            rideId: ride.id, cancelledById: auth.userId, actorType: actor, reasonCode: extra.cancel?.reasonCode ?? "OTHER", reasonText: extra.cancel?.reasonText,
            feeAmount: cancelFee, feeChargedTo: cancelFee > 0n ? "PASSENGER" : null,
          },
        });
        await tx.rideRequest.update({ where: { id: ride.rideRequestId }, data: { status: "CANCELLED", cancelledAt: now } });
        if (actor === "DRIVER") {
          const d = await tx.driver.findUniqueOrThrow({ where: { id: ride.driverId } });
          const n = d.tripsCompleted + 1;
          await tx.driver.update({ where: { id: d.id }, data: { cancellationRate: Math.min(1, (Number(d.cancellationRate) * (n - 1) + 1) / n) } });
        } else if (actor === "PASSENGER") {
          await tx.passengerProfile.update({ where: { id: ride.passengerId }, data: { cancellationCount: { increment: 1 } } });
        }
      }
    });

    if (to === "TRIP_COMPLETED" || to === "CANCELLED") await this.availability.markFree(ride.driverId);
    if (to === "TRIP_COMPLETED" && (settlementInfo as { method: string } | null)?.method === "WALLET") {
      await this.jobs.add("release", { rideId: ride.id }, { delayMs: env().EARNINGS_HOLD_S * 1000, jobId: `release-${ride.id}` });
    }
    const fresh = await this.load(ride.id);
    this.events.toRide(ride.id, "ride.status", { rideId: ride.id, status: fresh.status, version: fresh.version, at: now.toISOString(), finalFare: fresh.finalFare?.toString() ?? null, cancelFee: cancelFee.toString() });
    return rideView(fresh, actor === "SYSTEM" ? "ADMIN" : actor, null);
  }

  async rate(rideId: string, auth: AuthContext, body: RateBody) {
    const ride = await this.load(rideId);
    const actor = this.actorFor(ride, auth);
    if (actor === "ADMIN" || actor === "SYSTEM") fail("FORBIDDEN", "Only trip participants can rate");
    if (ride.status !== "TRIP_COMPLETED") fail("INVALID_STATE_TRANSITION", "You can rate after the trip is completed");
    const rateeUserId = actor === "PASSENGER" ? ride.driver.userId : ride.passenger.userId;
    try {
      await this.prisma.db.$transaction(async (tx) => {
        await tx.rideRating.create({ data: { rideId, raterId: auth.userId, rateeId: rateeUserId, raterRole: actor as "PASSENGER" | "DRIVER", stars: body.stars, comment: body.comment, tags: body.tags ?? [] } });
        if (actor === "PASSENGER") {
          const d = await tx.driver.findUniqueOrThrow({ where: { id: ride.driverId } });
          const avg = (Number(d.ratingAvg) * d.ratingCount + body.stars) / (d.ratingCount + 1);
          await tx.driver.update({ where: { id: d.id }, data: { ratingAvg: avg.toFixed(2), ratingCount: { increment: 1 } } });
        } else {
          const p = await tx.passengerProfile.findUniqueOrThrow({ where: { id: ride.passengerId } });
          const avg = (Number(p.ratingAvg) * p.ratingCount + body.stars) / (p.ratingCount + 1);
          await tx.passengerProfile.update({ where: { id: p.id }, data: { ratingAvg: avg.toFixed(2), ratingCount: { increment: 1 } } });
        }
      });
    } catch (e) {
      if (isUniqueViolation(e)) fail("ALREADY_RATED", "You already rated this trip");
      throw e;
    }
    return { ok: true };
  }

  async earnings(userId: string, period: "day" | "week" | "month"): Promise<EarningsView> {
    const d = await this.prisma.db.driver.findUnique({ where: { userId } });
    if (!d) fail("NOT_FOUND", "Driver not found");
    const since = new Date();
    // Day boundaries in Africa/Lagos (UTC+1, no DST).
    const lagosOffsetMs = 3600_000;
    const local = new Date(since.getTime() + lagosOffsetMs);
    local.setUTCHours(0, 0, 0, 0);
    if (period === "week") local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
    if (period === "month") local.setUTCDate(1);
    const from = new Date(local.getTime() - lagosOffsetMs);
    const rides = await this.prisma.db.ride.findMany({ where: { driverId: d!.id, status: "TRIP_COMPLETED", completedAt: { gte: from } }, include: { commission: true } });
    let gross = 0n, commission = 0n, cash = 0n;
    for (const r of rides) {
      const f = r.finalFare ?? r.agreedFare;
      gross += f;
      commission += r.commission?.amount ?? 0n;
      if (r.paymentMethod === "CASH") cash += f;
    }
    return { period, trips: rides.length, gross: gross.toString(), commission: commission.toString(), net: (gross - commission).toString(), cashCollected: cash.toString() };
  }
}
