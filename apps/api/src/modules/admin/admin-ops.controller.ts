import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import type { Prisma, RideStatus } from "@zuma/database";
import { z } from "zod";
import { fail } from "../../common/errors";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";
import { RequirePermission } from "../auth/auth.guard";
import { ACTIVE_RIDE_STATUSES } from "../rides/state-machine";
import { ChatService } from "../chat/chat.service";
import { TripsService } from "../rides/trips.service";
import { AdminContext, lagosDayStart, lagosHour, page, pageArgs } from "./admin.support";

const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) });

const RIDE_GROUPS: Record<string, RideStatus[]> = {
  active: ["DRIVER_SELECTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "TRIP_STARTED"],
  completed: ["TRIP_COMPLETED"],
  cancelled: ["CANCELLED"],
  disputed: ["DISPUTED"],
};

@Controller("v1/admin")
export class AdminOpsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly trips: TripsService,
    private readonly admin: AdminContext,
    private readonly chat: ChatService,
  ) {}

  // ---------------- overview ----------------

  @RequirePermission("dashboard:read")
  @Get("metrics/overview")
  async overview() {
    const db = this.prisma.db;
    const today = lagosDayStart(0);
    const yesterday = lagosDayStart(1);
    const weekAgo = lagosDayStart(6);

    const [activeTrips, onlineDrivers, openRequests, completedToday, completedYesterday, cancelledToday, commissionToday, commissionYesterday, grossToday, cashToday] = await Promise.all([
      db.ride.count({ where: { status: { in: ACTIVE_RIDE_STATUSES } } }),
      db.driverAvailability.count({ where: { status: { in: ["ONLINE", "ON_TRIP"] } } }),
      db.rideRequest.count({ where: { status: { in: ["SEARCHING", "OFFERS_RECEIVED"] }, expiresAt: { gt: new Date() } } }),
      db.ride.count({ where: { status: "TRIP_COMPLETED", completedAt: { gte: today } } }),
      db.ride.count({ where: { status: "TRIP_COMPLETED", completedAt: { gte: yesterday, lt: today } } }),
      db.ride.count({ where: { status: "CANCELLED", cancelledAt: { gte: today } } }),
      db.commission.aggregate({ _sum: { amount: true }, where: { createdAt: { gte: today } } }),
      db.commission.aggregate({ _sum: { amount: true }, where: { createdAt: { gte: yesterday, lt: today } } }),
      db.ride.aggregate({ _sum: { finalFare: true }, where: { status: "TRIP_COMPLETED", completedAt: { gte: today } } }),
      db.ride.aggregate({ _sum: { finalFare: true }, where: { status: "TRIP_COMPLETED", completedAt: { gte: today }, paymentMethod: "CASH" } }),
    ]);

    const wallets = await db.wallet.groupBy({ by: ["ownerType"], _sum: { availableBalance: true, pendingBalance: true, heldBalance: true } });
    const owedRows = await db.wallet.aggregate({ _sum: { availableBalance: true }, where: { ownerType: "DRIVER", availableBalance: { lt: 0 } } });
    const positive = await db.wallet.aggregate({ _sum: { availableBalance: true }, where: { availableBalance: { gt: 0 } } });
    const pendingHeld = wallets.reduce((s, w) => s + (w._sum.pendingBalance ?? 0n) + (w._sum.heldBalance ?? 0n), 0n);

    // Completed rides per Lagos hour today, and per day for the last 7 days.
    const recent = await db.ride.findMany({ where: { status: "TRIP_COMPLETED", completedAt: { gte: weekAgo } }, select: { completedAt: true, finalFare: true } });
    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, rides: 0 }));
    const byDay = Array.from({ length: 7 }, (_, i) => ({ date: lagosDayStart(6 - i).toISOString(), rides: 0, gross: 0n }));
    for (const r of recent) {
      if (!r.completedAt) continue;
      if (r.completedAt >= today) byHour[lagosHour(r.completedAt)]!.rides++;
      const idx = byDay.findIndex((d, i) => r.completedAt! >= new Date(d.date) && (i === 6 || r.completedAt! < new Date(byDay[i + 1]!.date)));
      if (idx >= 0) {
        byDay[idx]!.rides++;
        byDay[idx]!.gross += r.finalFare ?? 0n;
      }
    }

    const [pendingVerification, openTickets, openIncidents, pendingWithdrawals, disputedRides] = await Promise.all([
      db.driver.count({ where: { verificationStatus: { in: ["PENDING_REVIEW", "NOT_SUBMITTED"] } } }),
      db.supportTicket.count({ where: { status: { in: ["OPEN", "ASSIGNED"] } } }),
      db.safetyIncident.count({ where: { status: { in: ["TRIGGERED", "ACKNOWLEDGED", "ESCALATED_EXTERNAL"] } } }),
      db.withdrawal.count({ where: { status: { in: ["REQUESTED", "APPROVED"] } } }),
      db.ride.count({ where: { status: "DISPUTED" } }),
    ]);

    const finished = completedToday + cancelledToday;
    return {
      kpis: {
        activeTrips, onlineDrivers, openRequests, completedToday, completedYesterday, cancelledToday,
        cancellationRate: finished ? cancelledToday / finished : 0,
        commissionToday: (commissionToday._sum.amount ?? 0n).toString(),
        commissionYesterday: (commissionYesterday._sum.amount ?? 0n).toString(),
        grossToday: (grossToday._sum.finalFare ?? 0n).toString(),
        cashGrossToday: (cashToday._sum.finalFare ?? 0n).toString(),
        walletLiabilities: ((positive._sum.availableBalance ?? 0n) + pendingHeld).toString(),
        cashCommissionOwed: (-(owedRows._sum.availableBalance ?? 0n)).toString(),
      },
      byHour,
      byDay: byDay.map((d) => ({ ...d, gross: d.gross.toString() })),
      attention: { pendingVerification, openTickets, openIncidents, pendingWithdrawals, disputedRides },
    };
  }

  // ---------------- live map ----------------

  @RequirePermission("ops:live")
  @Get("live/snapshot")
  async live() {
    const db = this.prisma.db;
    const avail = await db.driverAvailability.findMany({
      where: { status: { in: ["ONLINE", "ON_TRIP", "PAUSED"] } },
      include: { driver: { include: { user: true, activeVehicle: { include: { category: true } } } } },
    });
    const keys = avail.map((a) => `drv:hb:${a.driverId}`);
    const hbs = keys.length ? await this.redis.client.mget(...keys) : [];
    const drivers = avail.flatMap((a, i) => {
      const hb = hbs[i] ? (JSON.parse(hbs[i]!) as { lat: number; lng: number; at: string }) : null;
      const lat = hb?.lat ?? a.lastLat;
      const lng = hb?.lng ?? a.lastLng;
      if (lat === null || lng === null || lat === undefined || lng === undefined) return [];
      return [{
        driverId: a.driverId, name: `${a.driver.user.firstName} ${a.driver.user.lastName}`.trim(), status: a.status,
        category: a.driver.activeVehicle?.category.key ?? null, plate: a.driver.activeVehicle?.plateNumber ?? null,
        lat, lng, lastSeen: hb?.at ?? a.lastHeartbeatAt?.toISOString() ?? null, stale: !hb,
      }];
    });
    const rides = await db.ride.findMany({
      where: { status: { in: ACTIVE_RIDE_STATUSES } },
      include: { rideRequest: true, passenger: { include: { user: true } }, driver: { include: { user: true } } },
      orderBy: { assignedAt: "desc" },
    });
    const openRequests = await db.rideRequest.findMany({
      where: { status: { in: ["SEARCHING", "OFFERS_RECEIVED"] }, expiresAt: { gt: new Date() } },
      include: { category: true, _count: { select: { offers: true } } },
    });
    return {
      drivers,
      rides: rides.map((r) => ({
        id: r.id, code: r.code, status: r.status, passenger: r.passenger.user.firstName, driver: r.driver.user.firstName, driverId: r.driverId,
        pickup: { address: r.rideRequest.pickupAddress, lat: r.rideRequest.pickupLat, lng: r.rideRequest.pickupLng },
        dropoff: { address: r.rideRequest.dropoffAddress, lat: r.rideRequest.dropoffLat, lng: r.rideRequest.dropoffLng },
        agreedFare: r.agreedFare.toString(), paymentMethod: r.paymentMethod,
      })),
      requests: openRequests.map((q) => ({ id: q.id, code: q.code, status: q.status, category: q.category.key, lat: q.pickupLat, lng: q.pickupLng, proposedFare: q.proposedFare.toString(), offers: q._count.offers, expiresAt: q.expiresAt.toISOString() })),
    };
  }

  // ---------------- rides ----------------

  @RequirePermission("rides:read")
  @Get("rides")
  async rides(@Query("group") group?: string, @Query("q") q?: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    const where: Prisma.RideWhereInput = {};
    if (group && RIDE_GROUPS[group]) where.status = { in: RIDE_GROUPS[group] };
    if (q?.trim()) {
      const s = q.trim();
      where.OR = [
        { code: { contains: s.toUpperCase() } },
        { passenger: { user: { OR: [{ firstName: { contains: s, mode: "insensitive" } }, { phoneE164: { contains: s } }] } } },
        { driver: { user: { OR: [{ firstName: { contains: s, mode: "insensitive" } }, { phoneE164: { contains: s } }] } } },
        { vehicle: { plateNumber: { contains: s.toUpperCase() } } },
      ];
    }
    const { _take, ...args } = pageArgs(cursor, limit);
    const rows = await this.prisma.db.ride.findMany({
      where, ...args, orderBy: { createdAt: "desc" },
      include: { rideRequest: true, passenger: { include: { user: true } }, driver: { include: { user: true } }, commission: true },
    });
    const counts = await Promise.all(Object.entries(RIDE_GROUPS).map(async ([k, v]) => [k, await this.prisma.db.ride.count({ where: { status: { in: v } } })] as const));
    const p = page(rows, _take);
    return {
      counts: { all: await this.prisma.db.ride.count(), ...Object.fromEntries(counts) },
      nextCursor: p.nextCursor,
      data: p.data.map((r) => ({
        id: r.id, code: r.code, status: r.status, passenger: `${r.passenger.user.firstName} ${r.passenger.user.lastName}`.trim(), driver: `${r.driver.user.firstName} ${r.driver.user.lastName}`.trim(),
        pickup: r.rideRequest.pickupAddress, dropoff: r.rideRequest.dropoffAddress, proposedFare: r.rideRequest.proposedFare.toString(),
        agreedFare: r.agreedFare.toString(), finalFare: r.finalFare?.toString() ?? null, commission: r.commission?.amount.toString() ?? null,
        paymentMethod: r.paymentMethod, createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  @RequirePermission("rides:read")
  @Get("rides/:id")
  async ride(@Param("id") id: string) {
    const db = this.prisma.db;
    const r = await db.ride.findUnique({
      where: { id },
      include: {
        rideRequest: { include: { category: true } }, passenger: { include: { user: true } }, driver: { include: { user: true } }, vehicle: true,
        commission: true, cancellation: true, ratings: true, payments: { include: { paymentMethod: true } }, receipt: true, promoRedemption: { include: { promoCode: true } },
      },
    });
    if (!r) fail("NOT_FOUND", "Ride not found");
    const ride = r!;
    const [negotiation, history, breadcrumbs, ledger, chat] = await Promise.all([
      db.fareNegotiation.findMany({ where: { rideRequestId: ride.rideRequestId }, orderBy: { createdAt: "asc" } }),
      db.rideStatusHistory.findMany({ where: { rideId: id }, orderBy: { createdAt: "asc" } }),
      db.rideLocation.findMany({ where: { rideId: id }, orderBy: { recordedAt: "asc" }, select: { lat: true, lng: true, recordedAt: true }, take: 2000 }),
      db.ledgerTransaction.findMany({ where: { rideId: id }, include: { entries: { include: { account: true } } }, orderBy: { postedAt: "asc" } }),
      this.chat.transcript(id),
    ]);
    const offerDrivers = await db.rideOffer.findMany({ where: { rideRequestId: ride.rideRequestId }, include: { driver: { include: { user: true } } } });
    const nameByUser = new Map(offerDrivers.map((o) => [o.driver.userId, o.driver.user.firstName]));
    nameByUser.set(ride.passenger.userId, ride.passenger.user.firstName);
    return {
      id: ride.id, code: ride.code, status: ride.status, category: ride.rideRequest.category.name,
      passenger: { name: `${ride.passenger.user.firstName} ${ride.passenger.user.lastName}`.trim(), phone: ride.passenger.user.phoneE164, rating: ride.passenger.ratingAvg.toString() },
      driver: { id: ride.driverId, name: `${ride.driver.user.firstName} ${ride.driver.user.lastName}`.trim(), phone: ride.driver.user.phoneE164, rating: ride.driver.ratingAvg.toString() },
      vehicle: { label: `${ride.vehicle.colour} ${ride.vehicle.make} ${ride.vehicle.model}`, plate: ride.vehicle.plateNumber },
      pickup: { address: ride.rideRequest.pickupAddress, lat: ride.rideRequest.pickupLat, lng: ride.rideRequest.pickupLng },
      dropoff: { address: ride.rideRequest.dropoffAddress, lat: ride.rideRequest.dropoffLat, lng: ride.rideRequest.dropoffLng },
      distanceM: ride.rideRequest.routeDistanceM, durationS: ride.rideRequest.routeDurationS,
      suggestedFare: ride.rideRequest.suggestedFare.toString(), proposedFare: ride.rideRequest.proposedFare.toString(),
      agreedFare: ride.agreedFare.toString(), finalFare: ride.finalFare?.toString() ?? null, commission: ride.commission?.amount.toString() ?? null, commissionBps: ride.commissionBps,
      paymentMethod: ride.paymentMethod, pinAttempts: ride.pinAttempts,
      discount: ride.discountAmount.toString(), promoCode: ride.promoRedemption?.promoCode.code ?? null,
      payments: ride.payments.map((p) => ({ reference: p.reference, method: p.method, status: p.status, amount: p.amount.toString(), fee: p.feeAmount.toString(), card: p.paymentMethod ? `${p.paymentMethod.cardBrand ?? "card"} ••${p.paymentMethod.cardLast4 ?? ""}` : null, failureReason: p.failureReason })),
      chat: chat.map((m) => ({ id: m.id, from: m.senderRole, body: m.body, imageUrl: m.imageUrl, flagged: m.flagged, at: m.createdAt })),
      times: { assignedAt: ride.assignedAt, arrivedAt: ride.arrivedAt, startedAt: ride.startedAt, completedAt: ride.completedAt, cancelledAt: ride.cancelledAt },
      cancellation: ride.cancellation ? { by: ride.cancellation.actorType, reason: ride.cancellation.reasonCode, text: ride.cancellation.reasonText, fee: ride.cancellation.feeAmount.toString() } : null,
      ratings: ride.ratings.map((x) => ({ by: x.raterRole, stars: x.stars, comment: x.comment })),
      negotiation: negotiation.map((e) => ({ at: e.createdAt, actor: e.actorType, who: e.actorUserId ? (nameByUser.get(e.actorUserId) ?? null) : null, action: e.action, amount: e.amount?.toString() ?? null, previous: e.previousAmount?.toString() ?? null })),
      statusHistory: history.map((h) => ({ at: h.createdAt, from: h.fromStatus, to: h.toStatus, actor: h.actorType, reason: h.reason })),
      breadcrumbs,
      ledger: ledger.map((t) => ({ id: t.id, type: t.type, description: t.description, postedAt: t.postedAt, entries: t.entries.map((e) => ({ account: e.account.code, direction: e.direction, amount: e.amount.toString() })) })),
    };
  }

  @RequirePermission("rides:write")
  @Post("rides/:id/cancel")
  @HttpCode(200)
  async cancel(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(ReasonBody)) body: { reason: string }) {
    const adminId = await this.admin.adminId(auth);
    const v = await this.trips.apply(id, "CANCEL", auth, { cancel: { reasonCode: "OTHER", reasonText: `Ops: ${body.reason}` } });
    await this.admin.action(adminId, "rides.cancel", "Ride", id, body.reason);
    return { id, status: v.status };
  }

  @RequirePermission("rides:write")
  @Post("rides/:id/dispute")
  @HttpCode(200)
  async dispute(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(ReasonBody)) body: { reason: string }) {
    const adminId = await this.admin.adminId(auth);
    const v = await this.trips.apply(id, "DISPUTE", auth);
    await this.prisma.db.dispute.create({ data: { rideId: id, raisedByType: "ADMIN", reason: body.reason, handlerId: adminId, status: "UNDER_REVIEW" } });
    await this.admin.action(adminId, "rides.dispute", "Ride", id, body.reason);
    return { id, status: v.status };
  }
}
