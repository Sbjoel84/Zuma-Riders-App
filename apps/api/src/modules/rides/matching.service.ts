import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { env } from "../../config/env";
import { haversineM } from "../../infra/maps.service";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";
import { AvailabilityService, geoKey } from "../geo/availability.service";
import { EventsService } from "../realtime/events.service";
import { JobsService } from "./jobs.service";
import { OPEN_REQUEST_STATUSES } from "./state-machine";
import { driverRequestView, requestInclude } from "./views";

const MAX_PER_WAVE = 10;
const ENOUGH_OFFERS = 3;

export interface Candidate {
  driverId: string;
  distanceM: number;
  ratingAvg: number;
  acceptanceRate: number;
  cancellationRate: number;
}

/** Pure ranking, unit-tested. Higher is better. */
export function rankScore(c: Candidate, radiusM: number): number {
  const proximity = Math.max(0, 1 - c.distanceM / Math.max(radiusM, 1));
  return 0.6 * proximity + 0.25 * (c.ratingAvg / 5) + 0.15 * c.acceptanceRate - 0.1 * c.cancellationRate;
}

@Injectable()
export class MatchingService implements OnModuleInit {
  private readonly log = new Logger("Matching");

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly availability: AvailabilityService,
    private readonly events: EventsService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register("expand", async (job) => this.expand(job.data.requestId));
    this.jobs.register("expire", async (job) => this.expire(job.data.requestId));
    this.jobs.register("sweep", async () => this.availability.sweepStale());
  }

  /** Start matching for a new request: first wave now, expansion and expiry scheduled. */
  async start(requestId: string, expiresAt: Date) {
    await this.dispatch(requestId);
    await this.jobs.add("expand", { requestId }, { delayMs: env().MATCH_EXPAND_AFTER_S * 1000, jobId: `expand-${requestId}-1` });
    await this.jobs.add("expire", { requestId }, { delayMs: Math.max(0, expiresAt.getTime() - Date.now()), jobId: `expire-${requestId}` });
  }

  /** Send the request to eligible drivers within the current radius that haven't seen it yet. */
  async dispatch(requestId: string, radiusOverrideM?: number): Promise<number> {
    const req = await this.prisma.db.rideRequest.findUnique({ where: { id: requestId }, include: { category: true, passenger: true } });
    if (!req || !OPEN_REQUEST_STATUSES.includes(req.status) || req.expiresAt < new Date()) return 0;
    const radius = radiusOverrideM ?? req.currentRadiusM;

    const raw = (await this.redis.client.geosearch(geoKey(req.serviceAreaId, req.category.key), "FROMLONLAT", req.pickupLng, req.pickupLat, "BYRADIUS", radius, "m", "ASC", "COUNT", 50, "WITHDIST")) as Array<[string, string]>;
    const nearby = raw.map(([id, dist]) => ({ driverId: id, distanceM: Math.round(parseFloat(dist)) }));

    const already = new Set((await this.prisma.db.rideDispatch.findMany({ where: { rideRequestId: requestId }, select: { driverId: true } })).map((d) => d.driverId));
    const fresh = [];
    for (const n of nearby) {
      if (already.has(n.driverId)) continue;
      if (await this.availability.isBusy(n.driverId)) continue;
      fresh.push(n);
    }

    let picked: Candidate[] = [];
    if (fresh.length) {
      const drivers = await this.prisma.db.driver.findMany({
        where: {
          id: { in: fresh.map((f) => f.driverId) },
          verificationStatus: "APPROVED",
          isBlacklisted: false,
          OR: [{ suspendedUntil: null }, { suspendedUntil: { lt: new Date() } }],
          user: { status: "ACTIVE", id: { not: req.passenger.userId } },
          activeVehicle: { status: "APPROVED", categoryId: req.categoryId },
        },
      });
      const byId = new Map(drivers.map((d) => [d.id, d]));
      picked = fresh
        .filter((f) => byId.has(f.driverId))
        .map((f) => {
          const d = byId.get(f.driverId)!;
          return { driverId: f.driverId, distanceM: f.distanceM, ratingAvg: Number(d.ratingAvg), acceptanceRate: Number(d.acceptanceRate), cancellationRate: Number(d.cancellationRate) };
        })
        .sort((a, b) => rankScore(b, radius) - rankScore(a, radius))
        .slice(0, MAX_PER_WAVE);
    }

    await this.prisma.db.$transaction(async (tx) => {
      if (picked.length) {
        await tx.rideDispatch.createMany({
          data: picked.map((p) => ({ rideRequestId: requestId, driverId: p.driverId, radiusM: radius, distanceToPickupM: p.distanceM, rankScore: rankScore(p, radius) })),
          skipDuplicates: true,
        });
      }
      await tx.rideRequest.updateMany({
        where: { id: requestId, status: { in: ["REQUESTED", "SEARCHING", "OFFERS_RECEIVED"] } },
        data: { currentRadiusM: radius, broadcastCount: { increment: picked.length } },
      });
      await tx.rideRequest.updateMany({ where: { id: requestId, status: "REQUESTED" }, data: { status: "SEARCHING" } });
    });

    if (picked.length) {
      const full = await this.prisma.db.rideRequest.findUniqueOrThrow({ where: { id: requestId }, include: requestInclude });
      for (const p of picked) this.events.toDriver(p.driverId, "ride_request.new", driverRequestView(full, p.driverId, p.distanceM));
    }
    return picked.length;
  }

  /** Re-broadcast to already-dispatched drivers (fare raised). */
  async notifyUpdate(requestId: string) {
    const full = await this.prisma.db.rideRequest.findUniqueOrThrow({ where: { id: requestId }, include: requestInclude });
    const dispatched = await this.prisma.db.rideDispatch.findMany({ where: { rideRequestId: requestId, declinedAt: null } });
    for (const d of dispatched) this.events.toDriver(d.driverId, "ride_request.updated", driverRequestView(full, d.driverId, d.distanceToPickupM));
  }

  async notifyClosed(requestId: string, reason: "ASSIGNED_OTHER" | "CANCELLED" | "EXPIRED", exceptDriverId?: string) {
    const dispatched = await this.prisma.db.rideDispatch.findMany({ where: { rideRequestId: requestId } });
    for (const d of dispatched) if (d.driverId !== exceptDriverId) this.events.toDriver(d.driverId, "ride_request.closed", { requestId, reason });
  }

  async expand(requestId: string) {
    const req = await this.prisma.db.rideRequest.findUnique({ where: { id: requestId }, include: { serviceArea: true, offers: { where: { status: "PENDING" } } } });
    if (!req || !OPEN_REQUEST_STATUSES.includes(req.status) || req.expiresAt < new Date()) return;
    if (req.offers.length >= ENOUGH_OFFERS || req.currentRadiusM >= req.serviceArea.maxSearchRadiusM) return;
    const next = Math.min(req.serviceArea.maxSearchRadiusM, req.currentRadiusM + req.serviceArea.radiusStepM);
    const sent = await this.dispatch(requestId, next);
    this.log.debug(`Request ${req.code}: radius ${req.currentRadiusM} → ${next} m, ${sent} more drivers`);
    if (next < req.serviceArea.maxSearchRadiusM) {
      const wave = Math.round(next / req.serviceArea.radiusStepM);
      await this.jobs.add("expand", { requestId }, { delayMs: env().MATCH_EXPAND_AFTER_S * 1000, jobId: `expand-${requestId}-${wave}` });
    }
  }

  async expire(requestId: string) {
    const now = new Date();
    const res = await this.prisma.db.$transaction(async (tx) => {
      const changed = await tx.rideRequest.updateMany({ where: { id: requestId, status: { in: OPEN_REQUEST_STATUSES }, expiresAt: { lte: new Date(now.getTime() + 1000) } }, data: { status: "EXPIRED" } });
      if (changed.count === 0) return null;
      await tx.rideOffer.updateMany({ where: { rideRequestId: requestId, status: "PENDING" }, data: { status: "EXPIRED" } });
      await tx.fareNegotiation.create({ data: { rideRequestId: requestId, actorType: "SYSTEM", action: "REQUEST_EXPIRED" } });
      return tx.rideRequest.findUniqueOrThrow({ where: { id: requestId }, include: { passenger: true } });
    });
    if (!res) return;
    this.events.toUser(res.passenger.userId, "ride_request.status", { requestId, status: "EXPIRED" });
    await this.notifyClosed(requestId, "EXPIRED");
  }

  /** Straight-line distance from a driver's last known position to pickup (pre-filter/display only). */
  async distanceToPickup(driverId: string, pickup: { lat: number; lng: number }): Promise<number | null> {
    const pos = await this.availability.position(driverId);
    return pos ? Math.round(haversineM(pos, pickup)) : null;
  }
}
