import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { fail } from "../../common/errors";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { PrismaService } from "../../infra/prisma.service";
import { RequirePermission } from "../auth/auth.guard";
import { AvailabilityService } from "../geo/availability.service";

const DecisionBody = z.object({ reason: z.string().trim().min(3).max(500) });
const SuspendBody = z.object({ reason: z.string().trim().min(3).max(500), until: z.string().datetime().optional() });

/**
 * Minimal admin surface for the ride slice: driver/vehicle approval, suspension and ride lookup.
 * Document review, finance, pricing and the dashboard arrive with the admin phase.
 * Every write records an AdminActionLog row.
 */
@Controller("v1/admin")
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
  ) {}

  private async adminId(auth: AuthContext) {
    const a = await this.prisma.db.adminProfile.findUnique({ where: { userId: auth.userId } });
    return a?.id ?? fail("FORBIDDEN", "Admin profile missing");
  }

  private async log(adminId: string, action: string, targetType: string, targetId: string, reason?: string) {
    await this.prisma.db.adminActionLog.create({ data: { adminId, action, targetType, targetId, reason } });
  }

  @RequirePermission("drivers:read")
  @Get("drivers")
  async drivers(@Query("verification") verification?: string) {
    const status = verification ? z.enum(["NOT_SUBMITTED", "PENDING_REVIEW", "APPROVED", "REJECTED", "EXPIRED"]).parse(verification) : undefined;
    const rows = await this.prisma.db.driver.findMany({
      where: status ? { verificationStatus: status } : {},
      include: { user: true, vehicles: { include: { category: true } }, availability: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map((d) => ({
      id: d.id, name: `${d.user.firstName} ${d.user.lastName}`.trim(), phone: d.user.phoneE164, verificationStatus: d.verificationStatus,
      licenceNumber: d.licenceNumber, ratingAvg: d.ratingAvg.toString(), tripsCompleted: d.tripsCompleted, availability: d.availability?.status ?? "OFFLINE",
      suspendedUntil: d.suspendedUntil, isBlacklisted: d.isBlacklisted,
      vehicles: d.vehicles.map((v) => ({ id: v.id, label: `${v.make} ${v.model} ${v.year}`, plateNumber: v.plateNumber, category: v.category.key, status: v.status })),
    }));
  }

  @RequirePermission("drivers:verify")
  @Post("drivers/:id/approve")
  @HttpCode(200)
  async approveDriver(@Auth() auth: AuthContext, @Param("id") id: string) {
    const adminId = await this.adminId(auth);
    const d = await this.prisma.db.driver.findUnique({ where: { id } });
    if (!d) fail("NOT_FOUND", "Driver not found");
    await this.prisma.db.$transaction([
      this.prisma.db.driver.update({ where: { id }, data: { verificationStatus: "APPROVED", approvedAt: new Date() } }),
      this.prisma.db.driverVerification.create({ data: { driverId: id, fromStatus: d!.verificationStatus, toStatus: "APPROVED", reviewerId: adminId } }),
    ]);
    await this.log(adminId, "drivers.approve", "Driver", id);
    return { id, verificationStatus: "APPROVED" };
  }

  @RequirePermission("drivers:verify")
  @Post("drivers/:id/reject")
  @HttpCode(200)
  async rejectDriver(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(DecisionBody)) body: { reason: string }) {
    const adminId = await this.adminId(auth);
    const d = await this.prisma.db.driver.findUnique({ where: { id } });
    if (!d) fail("NOT_FOUND", "Driver not found");
    await this.prisma.db.$transaction([
      this.prisma.db.driver.update({ where: { id }, data: { verificationStatus: "REJECTED" } }),
      this.prisma.db.driverVerification.create({ data: { driverId: id, fromStatus: d!.verificationStatus, toStatus: "REJECTED", reviewerId: adminId, notes: body.reason } }),
    ]);
    await this.availability.goOffline(id, "DOC_REJECTED");
    await this.log(adminId, "drivers.reject", "Driver", id, body.reason);
    return { id, verificationStatus: "REJECTED" };
  }

  @RequirePermission("drivers:verify")
  @Post("vehicles/:id/approve")
  @HttpCode(200)
  async approveVehicle(@Auth() auth: AuthContext, @Param("id") id: string) {
    const adminId = await this.adminId(auth);
    const v = await this.prisma.db.vehicle.findUnique({ where: { id }, include: { driver: true } });
    if (!v) fail("NOT_FOUND", "Vehicle not found");
    await this.prisma.db.vehicle.update({ where: { id }, data: { status: "APPROVED", approvedAt: new Date(), rejectionReason: null } });
    if (!v!.driver.activeVehicleId) await this.prisma.db.driver.update({ where: { id: v!.driverId }, data: { activeVehicleId: id } });
    await this.log(adminId, "vehicles.approve", "Vehicle", id);
    return { id, status: "APPROVED" };
  }

  @RequirePermission("drivers:write")
  @Post("drivers/:id/suspend")
  @HttpCode(200)
  async suspend(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(SuspendBody)) body: { reason: string; until?: string }) {
    const adminId = await this.adminId(auth);
    const until = body.until ? new Date(body.until) : new Date("2999-01-01T00:00:00Z");
    await this.prisma.db.driver.update({ where: { id }, data: { suspendedUntil: until } });
    await this.availability.goOffline(id, "SUSPENDED");
    await this.log(adminId, "drivers.suspend", "Driver", id, body.reason);
    return { id, suspendedUntil: until.toISOString() };
  }

  @RequirePermission("drivers:write")
  @Post("drivers/:id/reactivate")
  @HttpCode(200)
  async reactivate(@Auth() auth: AuthContext, @Param("id") id: string) {
    const adminId = await this.adminId(auth);
    await this.prisma.db.driver.update({ where: { id }, data: { suspendedUntil: null } });
    await this.log(adminId, "drivers.reactivate", "Driver", id);
    return { id, suspendedUntil: null };
  }

  @RequirePermission("rides:read")
  @Get("rides")
  async rides(@Query("status") status?: string) {
    const rows = await this.prisma.db.ride.findMany({
      where: status ? { status: status as never } : {},
      include: { rideRequest: true, passenger: { include: { user: true } }, driver: { include: { user: true } }, commission: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id, code: r.code, status: r.status, passenger: r.passenger.user.firstName, driver: r.driver.user.firstName,
      route: `${r.rideRequest.pickupAddress} → ${r.rideRequest.dropoffAddress}`, proposedFare: r.rideRequest.proposedFare.toString(),
      agreedFare: r.agreedFare.toString(), finalFare: r.finalFare?.toString() ?? null, commission: r.commission?.amount.toString() ?? null,
      paymentMethod: r.paymentMethod, createdAt: r.createdAt.toISOString(),
    }));
  }

  @RequirePermission("rides:read")
  @Get("rides/:id/negotiation")
  async negotiation(@Param("id") id: string) {
    const ride = await this.prisma.db.ride.findUnique({ where: { id } });
    if (!ride) fail("NOT_FOUND", "Ride not found");
    const [events, history] = await Promise.all([
      this.prisma.db.fareNegotiation.findMany({ where: { rideRequestId: ride!.rideRequestId }, orderBy: { createdAt: "asc" } }),
      this.prisma.db.rideStatusHistory.findMany({ where: { rideId: id }, orderBy: { createdAt: "asc" } }),
    ]);
    return {
      negotiation: events.map((e) => ({ at: e.createdAt, actor: e.actorType, action: e.action, amount: e.amount?.toString() ?? null })),
      statusHistory: history.map((h) => ({ at: h.createdAt, from: h.fromStatus, to: h.toStatus, actor: h.actorType, reason: h.reason })),
    };
  }
}
