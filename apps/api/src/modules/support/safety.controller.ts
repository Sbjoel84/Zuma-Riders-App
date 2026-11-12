import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import type { Prisma, SafetyIncidentStatus } from "@zuma/database";
import { z } from "zod";
import { DomainError, fail } from "../../common/errors";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { PrismaService } from "../../infra/prisma.service";
import { SmsService } from "../../infra/sms.service";
import { RequirePermission, Scopes } from "../auth/auth.guard";
import { AdminContext } from "../admin/admin.support";
import { EventsService } from "../realtime/events.service";
import { ACTIVE_RIDE_STATUSES } from "../rides/state-machine";

const SosBody = z.object({ rideId: z.string().optional(), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), note: z.string().max(500).optional() });
const ReportBody = z.object({ rideId: z.string(), type: z.enum(["UNSAFE_DRIVER", "UNSAFE_PASSENGER", "HARASSMENT", "ACCIDENT", "ROUTE_DEVIATION", "OTHER"]), description: z.string().trim().min(5).max(2000) });
const NoteBody = z.object({ note: z.string().trim().min(5).max(500) });

type TimelineEntry = { at: string; actor: string; event: string };
const name = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();

/**
 * SOS and safety reports. The platform alerts its own operations team only. It never contacts
 * emergency services itself and never says it has: `externalEscalatedAt` is set only when an
 * operator records that they actually reached an external service.
 */
@Scopes("PASSENGER", "DRIVER")
@Controller("v1/safety")
export class SafetyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly sms: SmsService,
  ) {}

  /** Texts the person's emergency contacts once per incident. Returns how many were reached. */
  private async alertContacts(incidentId: string, userId: string, lat: number, lng: number, ride: { code: string; vehicle: { colour: string; make: string; model: string; plateNumber: string }; driver: { user: { firstName: string } }; passenger: { user: { firstName: string } } } | null, reporterIsDriver: boolean) {
    const contacts = await this.prisma.db.emergencyContact.findMany({ where: { userId, deletedAt: null } });
    if (!contacts.length) return 0;
    const me = await this.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
    const time = new Date().toLocaleTimeString("en-NG", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit" });
    const trip = ride
      ? reporterIsDriver
        ? ` They were driving trip ${ride.code} with rider ${ride.passenger.user.firstName}.`
        : ` They were in a ${ride.vehicle.colour} ${ride.vehicle.make} ${ride.vehicle.model} ${ride.vehicle.plateNumber}, driver ${ride.driver.user.firstName}.`
      : "";
    const body = `URGENT: ${me.firstName} ${me.lastName} pressed SOS in the Riders App app at ${time}.${trip} Location: https://maps.google.com/?q=${lat.toFixed(5)},${lng.toFixed(5)} . Try to reach them. If you can't, call 112.`;
    let sent = 0;
    for (const c of contacts) await this.sms.send(c.phoneE164, body).then(() => sent++).catch(() => undefined);
    await this.prisma.db.safetyIncident.update({ where: { id: incidentId }, data: { contactsNotifiedAt: new Date() } });
    return sent;
  }

  @Post("sos")
  async sos(@Auth() auth: AuthContext, @Body(new ZodPipe(SosBody)) body: z.infer<typeof SosBody>) {
    let rideId: string | null = null;
    let cityId: string | null = null;
    const ride = body.rideId
      ? await this.prisma.db.ride.findUnique({ where: { id: body.rideId }, include: { passenger: { include: { user: true } }, driver: { include: { user: true } }, rideRequest: true, vehicle: true } })
      : await this.prisma.db.ride.findFirst({ where: { status: { in: ACTIVE_RIDE_STATUSES }, OR: [{ passenger: { userId: auth.userId } }, { driver: { userId: auth.userId } }] }, include: { passenger: { include: { user: true } }, driver: { include: { user: true } }, rideRequest: true, vehicle: true } });
    if (ride && (ride.passenger.userId === auth.userId || ride.driver.userId === auth.userId)) {
      rideId = ride.id;
      cityId = ride.rideRequest.cityId;
    }
    const city = cityId ? await this.prisma.db.city.findUnique({ where: { id: cityId } }) : await this.prisma.db.city.findFirst({ where: { isLive: true } });
    // One open SOS per person: repeated presses update the location instead of opening new incidents.
    const open = await this.prisma.db.safetyIncident.findFirst({ where: { reporterId: auth.userId, type: "SOS", status: { in: ["TRIGGERED", "ACKNOWLEDGED", "ESCALATED_EXTERNAL"] } } });
    const entry: TimelineEntry = { at: new Date().toISOString(), actor: auth.scope.toLowerCase(), event: open ? "Pressed SOS again" : "Pressed SOS" };
    const incident = open
      ? await this.prisma.db.safetyIncident.update({ where: { id: open.id }, data: { lat: body.lat, lng: body.lng, timeline: [...((open.timeline as TimelineEntry[] | null) ?? []), entry] } })
      : await this.prisma.db.safetyIncident.create({
          data: { type: "SOS", reporterId: auth.userId, reporterRole: auth.scope === "DRIVER" ? "DRIVER" : "PASSENGER", rideId, lat: body.lat, lng: body.lng, description: body.note, timeline: [entry] },
        });
    if (city) this.events.toAdmins(city.id, "admin.safety.incident", { id: incident.id, type: "SOS", rideId, lat: body.lat, lng: body.lng });
    const contactsNotified = open?.contactsNotifiedAt
      ? 0
      : await this.alertContacts(incident.id, auth.userId, body.lat, body.lng, rideId && ride ? ride : null, auth.scope === "DRIVER").catch(() => 0);
    if (contactsNotified) {
      await this.prisma.db.safetyIncident.update({
        where: { id: incident.id },
        data: { timeline: [...((incident.timeline as TimelineEntry[] | null) ?? []), { at: new Date().toISOString(), actor: "system", event: `Texted ${contactsNotified} emergency contact(s)` }] },
      });
    }
    return {
      incidentId: incident.id,
      opsAlerted: true,
      contactsNotified,
      emergencyServicesContacted: incident.externalEscalatedAt !== null,
      emergencyNumbers: (city?.supportContacts as { emergencyNumbers?: string[] } | null)?.emergencyNumbers ?? ["112"],
    };
  }

  @Post("reports")
  async report(@Auth() auth: AuthContext, @Body(new ZodPipe(ReportBody)) body: z.infer<typeof ReportBody>) {
    const ride = await this.prisma.db.ride.findUnique({ where: { id: body.rideId }, include: { passenger: true, driver: true, rideRequest: true } });
    if (!ride || (ride.passenger.userId !== auth.userId && ride.driver.userId !== auth.userId)) fail("NOT_FOUND", "Trip not found");
    const incident = await this.prisma.db.safetyIncident.create({
      data: {
        type: body.type, reporterId: auth.userId, reporterRole: auth.scope === "DRIVER" ? "DRIVER" : "PASSENGER", rideId: ride!.id, description: body.description,
        timeline: [{ at: new Date().toISOString(), actor: auth.scope.toLowerCase(), event: "Submitted safety report" }],
      },
    });
    this.events.toAdmins(ride!.rideRequest.cityId, "admin.safety.incident", { id: incident.id, type: body.type, rideId: ride!.id });
    return { incidentId: incident.id };
  }
}

@Controller("v1/admin/safety")
export class AdminSafetyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminContext,
  ) {}

  @RequirePermission("safety:write")
  @Get("incidents")
  async list(@Query("status") status?: string) {
    const where: Prisma.SafetyIncidentWhereInput = status === "open" ? { status: { in: ["TRIGGERED", "ACKNOWLEDGED", "ESCALATED_EXTERNAL"] } } : status ? { status: status as SafetyIncidentStatus } : {};
    const rows = await this.prisma.db.safetyIncident.findMany({
      where, orderBy: { createdAt: "desc" }, take: 100,
      include: { reporter: true, handler: { include: { user: true } }, ride: { include: { passenger: { include: { user: true } }, driver: { include: { user: true } }, vehicle: true, rideRequest: true } } },
    });
    return rows.map((i) => ({
      id: i.id, type: i.type, status: i.status, reporter: name(i.reporter), reporterPhone: i.reporter.phoneE164, reporterRole: i.reporterRole,
      lat: i.lat, lng: i.lng, description: i.description, createdAt: i.createdAt.toISOString(),
      ride: i.ride ? {
        id: i.ride.id, code: i.ride.code, status: i.ride.status, passenger: name(i.ride.passenger.user), passengerPhone: i.ride.passenger.user.phoneE164,
        driver: name(i.ride.driver.user), driverPhone: i.ride.driver.user.phoneE164, vehicle: `${i.ride.vehicle.colour} ${i.ride.vehicle.make} ${i.ride.vehicle.model} · ${i.ride.vehicle.plateNumber}`,
        route: `${i.ride.rideRequest.pickupAddress} → ${i.ride.rideRequest.dropoffAddress}`,
      } : null,
      handler: i.handler ? name(i.handler.user) : null,
      acknowledgedAt: i.acknowledgedAt?.toISOString() ?? null, externalEscalatedAt: i.externalEscalatedAt?.toISOString() ?? null,
      externalEscalationNote: i.externalEscalationNote, resolvedAt: i.resolvedAt?.toISOString() ?? null,
      timeline: (i.timeline as TimelineEntry[] | null) ?? [],
    }));
  }

  private async step(auth: AuthContext, id: string, allowed: SafetyIncidentStatus[], data: (adminName: string) => Prisma.SafetyIncidentUpdateInput, event: (adminName: string) => string, action: string, reason?: string) {
    const adminId = await this.admin.adminId(auth);
    const me = await this.prisma.db.user.findUniqueOrThrow({ where: { id: auth.userId } });
    const adminName = name(me);
    await this.prisma.db.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ status: SafetyIncidentStatus; timeline: TimelineEntry[] | null }>>`SELECT status, timeline FROM "SafetyIncident" WHERE id = ${id} FOR UPDATE`;
      if (!row) throw new DomainError("NOT_FOUND", "Incident not found");
      if (!allowed.includes(row.status)) throw new DomainError("INVALID_STATE_TRANSITION", `This incident is ${row.status.toLowerCase().replace(/_/g, " ")}`);
      await tx.safetyIncident.update({ where: { id }, data: { ...data(adminName), handler: { connect: { id: adminId } }, timeline: [...(row.timeline ?? []), { at: new Date().toISOString(), actor: adminName, event: event(adminName) }] } });
    });
    await this.admin.action(adminId, action, "SafetyIncident", id, reason);
    return { id };
  }

  @RequirePermission("safety:write")
  @Post("incidents/:id/acknowledge")
  @HttpCode(200)
  acknowledge(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.step(auth, id, ["TRIGGERED"], () => ({ status: "ACKNOWLEDGED", acknowledgedAt: new Date() }), (n) => `Acknowledged by ${n}`, "safety.acknowledge");
  }

  /** Records that the operator actually contacted police/ambulance. Only after this may anything say so. */
  @RequirePermission("safety:write")
  @Post("incidents/:id/escalation")
  @HttpCode(200)
  escalate(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(NoteBody)) body: { note: string }) {
    return this.step(auth, id, ["ACKNOWLEDGED"], () => ({ status: "ESCALATED_EXTERNAL", externalEscalatedAt: new Date(), externalEscalationNote: body.note }), (n) => `${n} recorded contact with emergency services: ${body.note}`, "safety.escalate", body.note);
  }

  @RequirePermission("safety:write")
  @Post("incidents/:id/resolve")
  @HttpCode(200)
  resolve(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(NoteBody)) body: { note: string }) {
    return this.step(auth, id, ["ACKNOWLEDGED", "ESCALATED_EXTERNAL"], () => ({ status: "RESOLVED", resolvedAt: new Date() }), (n) => `Resolved by ${n}: ${body.note}`, "safety.resolve", body.note);
  }

  @RequirePermission("safety:write")
  @Post("incidents/:id/false-alarm")
  @HttpCode(200)
  falseAlarm(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(NoteBody)) body: { note: string }) {
    return this.step(auth, id, ["TRIGGERED", "ACKNOWLEDGED"], () => ({ status: "FALSE_ALARM", resolvedAt: new Date() }), (n) => `Marked false alarm by ${n}: ${body.note}`, "safety.false_alarm", body.note);
  }
}
