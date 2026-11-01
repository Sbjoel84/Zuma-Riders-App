import { Injectable, Logger } from "@nestjs/common";
import { LocationPoint } from "@zuma/contracts";
import { env } from "../../config/env";
import { DomainError, fail } from "../../common/errors";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";
import { EventsService } from "../realtime/events.service";

export const geoKey = (areaId: string, categoryKey: string) => `drv:geo:${areaId}:${categoryKey}`;
const hbKey = (driverId: string) => `drv:hb:${driverId}`;
const busyKey = (driverId: string) => `drv:busy:${driverId}`;
const lastRideLocKey = (rideId: string) => `ride:lastloc:${rideId}`;

interface Heartbeat {
  lat: number;
  lng: number;
  heading?: number;
  at: string;
  areaId: string;
  categoryKey: string;
}

/**
 * Live driver availability. Hot state lives in Redis (GEO set per area+category, heartbeat key with TTL,
 * busy flag); DriverAvailability in Postgres is the durable mirror used by admin screens and recovery.
 */
@Injectable()
export class AvailabilityService {
  private readonly log = new Logger("Availability");

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly events: EventsService,
  ) {}

  async serviceAreaAt(lat: number, lng: number): Promise<{ id: string; cityId: string; searchRadiusM: number; maxSearchRadiusM: number; radiusStepM: number; restrictedCategoryKeys: string[] } | null> {
    const rows = await this.prisma.db.$queryRaw<Array<{ id: string; cityId: string; searchRadiusM: number; maxSearchRadiusM: number; radiusStepM: number; restrictedCategoryKeys: string[] }>>`
      SELECT id, "cityId", "searchRadiusM", "maxSearchRadiusM", "radiusStepM", "restrictedCategoryKeys"
      FROM "ServiceArea"
      WHERE status = 'ACTIVE' AND ST_Covers(boundary, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography)
      LIMIT 1`;
    return rows[0] ?? null;
  }

  /** Checks every rule that must hold before a driver may receive paid requests. */
  async assertCanGoOnline(userId: string) {
    const driver = await this.prisma.db.driver.findUnique({
      where: { userId },
      include: { user: true, activeVehicle: { include: { category: true } } },
    });
    if (!driver) fail("DRIVER_NOT_VERIFIED", "Finish driver registration first");
    const d = driver!;
    if (d.verificationStatus !== "APPROVED") fail("DRIVER_NOT_VERIFIED", "Your documents are still being reviewed");
    if (d.isBlacklisted || d.user.status !== "ACTIVE") fail("DRIVER_SUSPENDED", "Your account is not active. Contact support.");
    if (d.suspendedUntil && d.suspendedUntil > new Date()) fail("DRIVER_SUSPENDED", `Your account is suspended until ${d.suspendedUntil.toISOString()}`);
    if (!d.activeVehicle || d.activeVehicle.status !== "APPROVED") fail("NO_ACTIVE_VEHICLE", "Add a vehicle and wait for approval before going online");
    const wallet = await this.prisma.db.wallet.findUnique({ where: { userId_ownerType: { userId, ownerType: "DRIVER" } } });
    if (wallet && wallet.availableBalance < -wallet.negativeLimit) {
      fail("WALLET_LIMIT_EXCEEDED", "You owe more commission than the allowed limit. Top up your wallet to go online.", { owed: (-wallet.availableBalance).toString() });
    }
    return d;
  }

  async goOnline(userId: string, lat: number, lng: number) {
    const d = await this.assertCanGoOnline(userId);
    const area = await this.serviceAreaAt(lat, lng);
    if (!area) fail("OUTSIDE_SERVICE_AREA", "You are outside our service area");
    const categoryKey = d.activeVehicle!.category.key;
    if (area!.restrictedCategoryKeys.includes(categoryKey)) fail("CATEGORY_UNAVAILABLE", `${d.activeVehicle!.category.name} is not available in this area`);

    const activeRide = await this.prisma.db.ride.findFirst({ where: { driverId: d.id, status: { in: ["DRIVER_SELECTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "TRIP_STARTED"] } } });
    const status = activeRide ? "ON_TRIP" : "ONLINE";
    await this.prisma.db.driverAvailability.upsert({
      where: { driverId: d.id },
      update: { status, serviceAreaId: area!.id, lastHeartbeatAt: new Date(), lastLat: lat, lastLng: lng, wentOnlineAt: new Date() },
      create: { driverId: d.id, status, serviceAreaId: area!.id, lastHeartbeatAt: new Date(), lastLat: lat, lastLng: lng, wentOnlineAt: new Date() },
    });
    const hb: Heartbeat = { lat, lng, at: new Date().toISOString(), areaId: area!.id, categoryKey };
    const pipe = this.redis.client.pipeline().set(hbKey(d.id), JSON.stringify(hb), "EX", env().DRIVER_HEARTBEAT_TTL_S);
    if (!activeRide) pipe.geoadd(geoKey(area!.id, categoryKey), lng, lat, d.id);
    else pipe.set(busyKey(d.id), activeRide.id);
    await pipe.exec();
    return { status, serviceAreaId: area!.id, categoryKey };
  }

  async goOffline(driverId: string, reason?: string) {
    const raw = await this.redis.client.get(hbKey(driverId));
    const hb = raw ? (JSON.parse(raw) as Heartbeat) : null;
    const pipe = this.redis.client.pipeline().del(hbKey(driverId));
    if (hb) pipe.zrem(geoKey(hb.areaId, hb.categoryKey), driverId);
    await pipe.exec();
    await this.prisma.db.driverAvailability.updateMany({ where: { driverId }, data: { status: "OFFLINE" } });
    if (reason) this.events.toDriver(driverId, "driver.forced_offline", { reason });
  }

  /** Location ping from the driver app (socket or REST fallback). Returns the active ride id, if any. */
  async updateLocation(driverId: string, p: LocationPoint): Promise<string | null> {
    const raw = await this.redis.client.get(hbKey(driverId));
    if (!raw) throw new DomainError("FORBIDDEN", "Go online before sending location");
    const hb = JSON.parse(raw) as Heartbeat;
    const next: Heartbeat = { ...hb, lat: p.lat, lng: p.lng, heading: p.heading, at: new Date().toISOString() };
    const rideId = await this.redis.client.get(busyKey(driverId));
    const pipe = this.redis.client.pipeline().set(hbKey(driverId), JSON.stringify(next), "EX", env().DRIVER_HEARTBEAT_TTL_S);
    if (!rideId) pipe.geoadd(geoKey(hb.areaId, hb.categoryKey), p.lng, p.lat, driverId);
    await pipe.exec();

    if (rideId) {
      this.events.toRide(rideId, "ride.driver_location", { rideId, lat: p.lat, lng: p.lng, heading: p.heading ?? null, at: p.recordedAt });
      // Persist breadcrumbs at most every 5 s per ride; replayed offline batches are de-duplicated by clientSeq.
      const ok = await this.redis.client.set(lastRideLocKey(rideId), "1", "PX", 5000, "NX");
      if (ok) {
        await this.prisma.db.rideLocation
          .create({ data: { rideId, lat: p.lat, lng: p.lng, heading: p.heading, speedKmh: p.speedKmh, accuracyM: p.accuracyM, recordedAt: new Date(p.recordedAt), clientSeq: p.clientSeq } })
          .catch(() => undefined);
      }
    }
    return rideId;
  }

  async position(driverId: string): Promise<{ lat: number; lng: number } | null> {
    const raw = await this.redis.client.get(hbKey(driverId));
    if (!raw) return null;
    const hb = JSON.parse(raw) as Heartbeat;
    return { lat: hb.lat, lng: hb.lng };
  }

  async isBusy(driverId: string): Promise<boolean> {
    return (await this.redis.client.exists(busyKey(driverId))) === 1;
  }

  /** Called after a ride is assigned: hide the driver from matching. */
  async markBusy(driverId: string, rideId: string) {
    const raw = await this.redis.client.get(hbKey(driverId));
    const pipe = this.redis.client.pipeline().set(busyKey(driverId), rideId);
    if (raw) {
      const hb = JSON.parse(raw) as Heartbeat;
      pipe.zrem(geoKey(hb.areaId, hb.categoryKey), driverId);
    }
    await pipe.exec();
    await this.prisma.db.driverAvailability.updateMany({ where: { driverId }, data: { status: "ON_TRIP" } });
  }

  /** Called when a ride ends: driver becomes matchable again if still online. */
  async markFree(driverId: string) {
    await this.redis.client.del(busyKey(driverId));
    const raw = await this.redis.client.get(hbKey(driverId));
    if (raw) {
      const hb = JSON.parse(raw) as Heartbeat;
      await this.redis.client.geoadd(geoKey(hb.areaId, hb.categoryKey), hb.lng, hb.lat, driverId);
      await this.prisma.db.driverAvailability.updateMany({ where: { driverId }, data: { status: "ONLINE" } });
    } else {
      await this.prisma.db.driverAvailability.updateMany({ where: { driverId }, data: { status: "OFFLINE" } });
    }
  }

  /** Drivers whose heartbeat expired (app killed, no network) are taken offline. Runs on the worker. */
  async sweepStale() {
    const online = await this.prisma.db.driverAvailability.findMany({ where: { status: { in: ["ONLINE", "PAUSED"] } }, select: { driverId: true } });
    for (const { driverId } of online) {
      if (!(await this.redis.client.exists(hbKey(driverId)))) {
        await this.goOffline(driverId, "HEARTBEAT_LOST");
        this.log.log(`Driver ${driverId} went offline (heartbeat lost)`);
      }
    }
  }
}
