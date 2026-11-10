import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import { normalizeNigerianPhone } from "@zuma/contracts";
import type { Prisma } from "@zuma/database";
import { z } from "zod";
import { fail } from "../../common/errors";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";
import { RequirePermission } from "../auth/auth.guard";
import { AuthService } from "../auth/auth.service";
import { AvailabilityService } from "../geo/availability.service";
import { DocumentsService } from "../files/documents.service";
import { NotificationsService } from "../notifications/notifications.service";
import { OPEN_REQUEST_STATUSES } from "../rides/state-machine";
import { AdminContext, lagosDayStart, page, pageArgs } from "./admin.support";

const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) });
const SuspendBody = z.object({ reason: z.string().trim().min(3).max(500), until: z.string().datetime().optional() });
const AdminBody = z.object({ phone: z.string().min(7).max(20), firstName: z.string().trim().min(1).max(60), lastName: z.string().trim().min(1).max(60), roleKey: z.string() });
const RoleBody = z.object({ roleKey: z.string() });
const OptionalReason = z.object({ reason: z.string().trim().min(3).max(300).optional() });

const name = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim() || "(no name yet)";

@Controller("v1/admin")
export class AdminPeopleController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly availability: AvailabilityService,
    private readonly auth: AuthService,
    private readonly admin: AdminContext,
    private readonly documents: DocumentsService,
    private readonly notify: NotificationsService,
  ) {}

  // ---------------- drivers ----------------

  @RequirePermission("drivers:read")
  @Get("drivers")
  async drivers(@Query("status") status?: string, @Query("q") q?: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    const where: Prisma.DriverWhereInput = {};
    const now = new Date();
    if (status === "active") Object.assign(where, { verificationStatus: "APPROVED", isBlacklisted: false, OR: [{ suspendedUntil: null }, { suspendedUntil: { lt: now } }] });
    if (status === "suspended") Object.assign(where, { OR: [{ suspendedUntil: { gt: now } }, { isBlacklisted: true }] });
    if (status === "pending") Object.assign(where, { verificationStatus: { in: ["PENDING_REVIEW", "NOT_SUBMITTED", "REJECTED"] } });
    if (q?.trim()) {
      const s = q.trim();
      where.AND = [{ OR: [{ user: { firstName: { contains: s, mode: "insensitive" } } }, { user: { lastName: { contains: s, mode: "insensitive" } } }, { user: { phoneE164: { contains: s.replace(/^0/, "") } } }, { vehicles: { some: { plateNumber: { contains: s.toUpperCase() } } } }] }];
    }
    const { _take, ...args } = pageArgs(cursor, limit);
    const rows = await this.prisma.db.driver.findMany({
      where, ...args, orderBy: { createdAt: "desc" },
      include: { user: true, activeVehicle: { include: { category: true } }, vehicles: true, availability: true },
    });
    const ids = rows.map((r) => r.id);
    const weekStart = lagosDayStart(6);
    const [earn, wallets] = await Promise.all([
      this.prisma.db.commission.groupBy({ by: ["driverId"], where: { driverId: { in: ids }, createdAt: { gte: weekStart } }, _sum: { grossFare: true, amount: true } }),
      this.prisma.db.wallet.findMany({ where: { ownerType: "DRIVER", userId: { in: rows.map((r) => r.userId) } } }),
    ]);
    const earnBy = new Map(earn.map((e) => [e.driverId, (e._sum.grossFare ?? 0n) - (e._sum.amount ?? 0n)]));
    const walletBy = new Map(wallets.map((w) => [w.userId, w]));
    const counts = {
      all: await this.prisma.db.driver.count(),
      active: await this.prisma.db.driver.count({ where: { verificationStatus: "APPROVED", isBlacklisted: false, OR: [{ suspendedUntil: null }, { suspendedUntil: { lt: now } }] } }),
      suspended: await this.prisma.db.driver.count({ where: { OR: [{ suspendedUntil: { gt: now } }, { isBlacklisted: true }] } }),
      pending: await this.prisma.db.driver.count({ where: { verificationStatus: { in: ["PENDING_REVIEW", "NOT_SUBMITTED", "REJECTED"] } } }),
    };
    const p = page(rows, _take);
    return {
      counts, nextCursor: p.nextCursor,
      data: p.data.map((d) => {
        const suspended = d.isBlacklisted || (d.suspendedUntil !== null && d.suspendedUntil > now);
        const w = walletBy.get(d.userId);
        return {
          id: d.id, name: name(d.user), phone: d.user.phoneE164,
          vehicle: d.activeVehicle ? `${d.activeVehicle.make} ${d.activeVehicle.model} ${d.activeVehicle.year}` : d.vehicles[0] ? `${d.vehicles[0].make} ${d.vehicles[0].model} ${d.vehicles[0].year}` : null,
          plate: d.activeVehicle?.plateNumber ?? d.vehicles[0]?.plateNumber ?? null, category: d.activeVehicle?.category.name ?? null,
          rating: d.ratingAvg.toString(), ratingCount: d.ratingCount, trips: d.tripsCompleted, netThisWeek: (earnBy.get(d.id) ?? 0n).toString(),
          walletBalance: w?.availableBalance.toString() ?? "0", availability: d.availability?.status ?? "OFFLINE",
          verificationStatus: d.verificationStatus, status: suspended ? "SUSPENDED" : d.verificationStatus === "APPROVED" ? "ACTIVE" : "PENDING",
          suspendedUntil: d.suspendedUntil?.toISOString() ?? null,
        };
      }),
    };
  }

  @RequirePermission("drivers:write")
  @Post("drivers/:id/suspend")
  @HttpCode(200)
  async suspend(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(SuspendBody)) body: { reason: string; until?: string }) {
    const adminId = await this.admin.adminId(auth);
    const d = await this.prisma.db.driver.findUnique({ where: { id } });
    if (!d) fail("NOT_FOUND", "Driver not found");
    const until = body.until ? new Date(body.until) : new Date("2999-01-01T00:00:00Z");
    await this.prisma.db.driver.update({ where: { id }, data: { suspendedUntil: until } });
    await this.availability.goOffline(id, "SUSPENDED");
    await this.admin.action(adminId, "drivers.suspend", "Driver", id, body.reason);
    return { id, suspendedUntil: until.toISOString() };
  }

  @RequirePermission("drivers:write")
  @Post("drivers/:id/reactivate")
  @HttpCode(200)
  async reactivate(@Auth() auth: AuthContext, @Param("id") id: string) {
    const adminId = await this.admin.adminId(auth);
    await this.prisma.db.driver.update({ where: { id }, data: { suspendedUntil: null, isBlacklisted: false } });
    await this.admin.action(adminId, "drivers.reactivate", "Driver", id);
    return { id, suspendedUntil: null };
  }

  // ---------------- verification ----------------

  @RequirePermission("drivers:verify")
  @Get("verification")
  async queue() {
    const rows = await this.prisma.db.driver.findMany({
      where: { OR: [{ verificationStatus: { in: ["PENDING_REVIEW", "NOT_SUBMITTED", "REJECTED"] } }, { vehicles: { some: { status: "PENDING_REVIEW", deletedAt: null } } }] },
      include: {
        user: true, documents: { where: { supersededAt: null }, select: { status: true } },
        vehicles: { where: { deletedAt: null }, include: { category: true, documents: { where: { supersededAt: null }, select: { status: true } } } },
        verifications: { orderBy: { createdAt: "desc" }, take: 5, include: { reviewer: { include: { user: true } } } },
      },
      orderBy: { createdAt: "asc" },
    });
    const count = (docs: { status: string }[]) => ({ uploaded: docs.length, approved: docs.filter((x) => x.status === "APPROVED").length, pending: docs.filter((x) => x.status === "PENDING").length, rejected: docs.filter((x) => x.status === "REJECTED").length });
    return rows.map((d) => ({
      documents: { ...count([...d.documents, ...d.vehicles.flatMap((v) => v.documents)]), required: 3 + d.vehicles.length * 5 },
      id: d.id, name: name(d.user), phone: d.user.phoneE164, submittedAt: d.createdAt.toISOString(),
      verificationStatus: d.verificationStatus, licenceNumber: d.licenceNumber, licenceExpiresAt: d.licenceExpiresAt?.toISOString() ?? null, address: d.addressLine,
      vehicles: d.vehicles.map((v) => ({ id: v.id, label: `${v.colour} ${v.make} ${v.model} ${v.year}`, plate: v.plateNumber, category: v.category.name, minYear: v.category.minYear, year: v.year, status: v.status, rejectionReason: v.rejectionReason })),
      history: d.verifications.map((h) => ({ at: h.createdAt.toISOString(), to: h.toStatus, notes: h.notes, by: h.reviewer ? name(h.reviewer.user) : null })),
    }));
  }

  @RequirePermission("drivers:verify")
  @Post("drivers/:id/approve")
  @HttpCode(200)
  async approveDriver(@Auth() auth: AuthContext, @Param("id") id: string) {
    const adminId = await this.admin.adminId(auth);
    const d = await this.prisma.db.driver.findUnique({ where: { id } });
    if (!d) fail("NOT_FOUND", "Driver not found");
    await this.documents.assertDriverReady(id);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.driver.update({ where: { id }, data: { verificationStatus: "APPROVED", approvedAt: new Date() } });
      await tx.driverVerification.create({ data: { driverId: id, fromStatus: d!.verificationStatus, toStatus: "APPROVED", reviewerId: adminId } });
      await this.admin.action(adminId, "drivers.approve", "Driver", id, undefined, tx);
    });
    this.notify.send(d!.userId, { category: "ACCOUNT", title: "You're approved to drive", body: "Welcome to Zuma. Go online to start receiving ride requests.", data: { type: "home" } });
    return { id, verificationStatus: "APPROVED" };
  }

  @RequirePermission("drivers:verify")
  @Post("drivers/:id/reject")
  @HttpCode(200)
  async rejectDriver(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(ReasonBody)) body: { reason: string }) {
    const adminId = await this.admin.adminId(auth);
    const d = await this.prisma.db.driver.findUnique({ where: { id } });
    if (!d) fail("NOT_FOUND", "Driver not found");
    await this.prisma.db.$transaction(async (tx) => {
      await tx.driver.update({ where: { id }, data: { verificationStatus: "REJECTED" } });
      await tx.driverVerification.create({ data: { driverId: id, fromStatus: d!.verificationStatus, toStatus: "REJECTED", reviewerId: adminId, notes: body.reason } });
      await this.admin.action(adminId, "drivers.reject", "Driver", id, body.reason, tx);
    });
    await this.availability.goOffline(id, "DOC_REJECTED");
    this.notify.send(d!.userId, { category: "ACCOUNT", title: "Your application needs changes", body: body.reason, data: { type: "documents" } });
    return { id, verificationStatus: "REJECTED" };
  }

  @RequirePermission("drivers:verify")
  @Post("vehicles/:id/approve")
  @HttpCode(200)
  async approveVehicle(@Auth() auth: AuthContext, @Param("id") id: string) {
    const adminId = await this.admin.adminId(auth);
    const v = await this.prisma.db.vehicle.findUnique({ where: { id }, include: { driver: true } });
    if (!v) fail("NOT_FOUND", "Vehicle not found");
    await this.documents.assertVehicleReady(id);
    await this.prisma.db.vehicle.update({ where: { id }, data: { status: "APPROVED", approvedAt: new Date(), rejectionReason: null } });
    this.notify.send(v!.driver.userId, { category: "ACCOUNT", title: "Vehicle approved", body: `Your ${v!.make} ${v!.model} (${v!.plateNumber}) is approved.`, data: { type: "home" } });
    if (!v!.driver.activeVehicleId) await this.prisma.db.driver.update({ where: { id: v!.driverId }, data: { activeVehicleId: id } });
    await this.admin.action(adminId, "vehicles.approve", "Vehicle", id);
    return { id, status: "APPROVED" };
  }

  @RequirePermission("drivers:verify")
  @Post("vehicles/:id/reject")
  @HttpCode(200)
  async rejectVehicle(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(ReasonBody)) body: { reason: string }) {
    const adminId = await this.admin.adminId(auth);
    const v = await this.prisma.db.vehicle.findUnique({ where: { id }, include: { driver: true } });
    if (!v) fail("NOT_FOUND", "Vehicle not found");
    await this.prisma.db.vehicle.update({ where: { id }, data: { status: "REJECTED", rejectionReason: body.reason } });
    if (v!.driver.activeVehicleId === id) {
      await this.prisma.db.driver.update({ where: { id: v!.driverId }, data: { activeVehicleId: null } });
      await this.availability.goOffline(v!.driverId, "DOC_REJECTED");
    }
    await this.admin.action(adminId, "vehicles.reject", "Vehicle", id, body.reason);
    this.notify.send(v!.driver.userId, { category: "ACCOUNT", title: "Vehicle not approved", body: body.reason, data: { type: "documents" } });
    return { id, status: "REJECTED" };
  }

  @RequirePermission("drivers:verify")
  @Get("drivers/:id/documents")
  driverDocuments(@Param("id") id: string) {
    return this.documents.forAdmin(id);
  }

  @RequirePermission("drivers:verify")
  @Post("documents/:kind/:id/:decision")
  @HttpCode(200)
  async reviewDocument(@Auth() auth: AuthContext, @Param("kind") kind: string, @Param("id") id: string, @Param("decision") decision: string, @Body(new ZodPipe(OptionalReason)) body: { reason?: string }) {
    const k = z.enum(["driver", "vehicle"]).parse(kind);
    const dec = z.enum(["approve", "reject"]).parse(decision);
    const adminId = await this.admin.adminId(auth);
    const r = await this.documents.review(adminId, k, id, dec, body.reason);
    await this.admin.action(adminId, `documents.${dec}`, k === "driver" ? "DriverDocument" : "VehicleDocument", id, body.reason);
    return r;
  }

  // ---------------- passengers ----------------

  @RequirePermission("passengers:read")
  @Get("passengers")
  async passengers(@Query("q") q?: string, @Query("status") status?: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    const where: Prisma.PassengerProfileWhereInput = {};
    const userWhere: Prisma.UserWhereInput = {};
    if (status === "suspended") userWhere.status = { in: ["SUSPENDED", "BLACKLISTED"] };
    if (status === "active") userWhere.status = "ACTIVE";
    if (q?.trim()) {
      const s = q.trim();
      userWhere.OR = [{ firstName: { contains: s, mode: "insensitive" } }, { lastName: { contains: s, mode: "insensitive" } }, { phoneE164: { contains: s.replace(/^0/, "") } }, { email: { contains: s } }];
    }
    where.user = userWhere;
    const { _take, ...args } = pageArgs(cursor, limit);
    const rows = await this.prisma.db.passengerProfile.findMany({ where, ...args, orderBy: { createdAt: "desc" }, include: { user: true } });
    const wallets = await this.prisma.db.wallet.findMany({ where: { ownerType: "PASSENGER", userId: { in: rows.map((r) => r.userId) } } });
    const wBy = new Map(wallets.map((w) => [w.userId, w.availableBalance]));
    const p = page(rows, _take);
    return {
      total: await this.prisma.db.passengerProfile.count({ where }),
      nextCursor: p.nextCursor,
      data: p.data.map((x) => ({
        id: x.id, userId: x.userId, name: name(x.user), phone: x.user.phoneE164, email: x.user.email, joinedAt: x.createdAt.toISOString(),
        trips: x.tripsCompleted, rating: x.ratingAvg.toString(), cancellations: x.cancellationCount, wallet: (wBy.get(x.userId) ?? 0n).toString(),
        status: x.user.status, statusReason: x.user.statusReason,
      })),
    };
  }

  @RequirePermission("passengers:write")
  @Post("users/:userId/suspend")
  @HttpCode(200)
  async suspendUser(@Auth() auth: AuthContext, @Param("userId") userId: string, @Body(new ZodPipe(ReasonBody)) body: { reason: string }) {
    const adminId = await this.admin.adminId(auth);
    const u = await this.prisma.db.user.findUnique({ where: { id: userId }, include: { adminProfile: true, passengerProfile: true } });
    if (!u) fail("NOT_FOUND", "User not found");
    if (u!.adminProfile) fail("FORBIDDEN", "Admin accounts are managed in Settings");
    await this.prisma.db.user.update({ where: { id: userId }, data: { status: "SUSPENDED", statusReason: body.reason } });
    if (u!.passengerProfile) {
      await this.prisma.db.rideRequest.updateMany({ where: { passengerId: u!.passengerProfile.id, status: { in: OPEN_REQUEST_STATUSES } }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    }
    await this.auth.logoutAll(userId);
    await this.admin.action(adminId, "users.suspend", "User", userId, body.reason);
    return { userId, status: "SUSPENDED" };
  }

  @RequirePermission("passengers:write")
  @Post("users/:userId/reactivate")
  @HttpCode(200)
  async reactivateUser(@Auth() auth: AuthContext, @Param("userId") userId: string) {
    const adminId = await this.admin.adminId(auth);
    await this.prisma.db.user.update({ where: { id: userId }, data: { status: "ACTIVE", statusReason: null } });
    await this.admin.action(adminId, "users.reactivate", "User", userId);
    return { userId, status: "ACTIVE" };
  }

  // ---------------- admins & roles ----------------

  @RequirePermission("dashboard:read")
  @Get("me")
  async me(@Auth() auth: AuthContext) {
    const u = await this.prisma.db.user.findUniqueOrThrow({ where: { id: auth.userId }, include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } } });
    return {
      id: u.id, name: name(u), phone: u.phoneE164,
      roles: u.roles.map((r) => ({ key: r.role.key, name: r.role.name })),
      permissions: [...new Set(u.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.key)))],
    };
  }

  @RequirePermission("rbac:write")
  @Get("admins")
  async admins() {
    const rows = await this.prisma.db.adminProfile.findMany({ include: { user: { include: { roles: { include: { role: true } }, sessions: { orderBy: { lastUsedAt: "desc" }, take: 1 } } } }, orderBy: { createdAt: "asc" } });
    const roles = await this.prisma.db.role.findMany({ where: { scope: "ADMIN" }, include: { permissions: { include: { permission: true } } }, orderBy: { name: "asc" } });
    return {
      admins: rows.map((a) => ({
        id: a.id, userId: a.userId, name: name(a.user), phone: a.user.phoneE164, status: a.user.status,
        roles: a.user.roles.filter((r) => r.role.scope === "ADMIN").map((r) => ({ key: r.role.key, name: r.role.name })),
        lastLoginAt: a.user.lastLoginAt?.toISOString() ?? null, createdAt: a.createdAt.toISOString(), twoFactor: Boolean(a.totpEnabledAt),
      })),
      roles: roles.map((r) => ({ key: r.key, name: r.name, permissions: r.permissions.map((p) => p.permission.key) })),
    };
  }

  @RequirePermission("rbac:write")
  @Post("admins")
  async createAdmin(@Auth() auth: AuthContext, @Body(new ZodPipe(AdminBody)) body: z.infer<typeof AdminBody>) {
    const adminId = await this.admin.adminId(auth);
    const phone = normalizeNigerianPhone(body.phone) ?? fail("VALIDATION_FAILED", "Enter a valid phone number");
    const role = await this.prisma.db.role.findUnique({ where: { key: body.roleKey } });
    if (!role || role.scope !== "ADMIN") fail("VALIDATION_FAILED", "Choose an admin role");
    const created = await this.prisma.db.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { phoneE164: phone },
        update: {},
        create: { phoneE164: phone, firstName: body.firstName, lastName: body.lastName, status: "ACTIVE", referralCode: "ADM" + Date.now().toString(36).toUpperCase() },
      });
      const profile = await tx.adminProfile.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id } });
      await tx.userRole.deleteMany({ where: { userId: user.id, role: { scope: "ADMIN" } } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role!.id, grantedById: auth.userId } });
      await this.admin.audit(adminId, "AdminProfile", profile.id, "CREATE", null, { phone, role: role!.key }, tx);
      return { id: profile.id, userId: user.id };
    });
    await this.redis.client.del(`perms:${created.userId}`);
    return created;
  }

  @RequirePermission("rbac:write")
  @Put("admins/:userId/role")
  async setRole(@Auth() auth: AuthContext, @Param("userId") userId: string, @Body(new ZodPipe(RoleBody)) body: { roleKey: string }) {
    const adminId = await this.admin.adminId(auth);
    if (userId === auth.userId) fail("FORBIDDEN", "You can't change your own role");
    const role = await this.prisma.db.role.findUnique({ where: { key: body.roleKey } });
    if (!role || role.scope !== "ADMIN") fail("VALIDATION_FAILED", "Choose an admin role");
    const before = await this.prisma.db.userRole.findMany({ where: { userId, role: { scope: "ADMIN" } }, include: { role: true } });
    await this.prisma.db.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId, role: { scope: "ADMIN" } } });
      await tx.userRole.create({ data: { userId, roleId: role!.id, grantedById: auth.userId } });
      await this.admin.audit(adminId, "UserRole", userId, "UPDATE", { roles: before.map((b) => b.role.key) }, { roles: [role!.key] }, tx);
    });
    await this.redis.client.del(`perms:${userId}`);
    await this.auth.logoutAll(userId);
    return { userId, role: role!.key };
  }

  @RequirePermission("rbac:write")
  @Post("admins/:userId/revoke")
  @HttpCode(200)
  async revoke(@Auth() auth: AuthContext, @Param("userId") userId: string) {
    const adminId = await this.admin.adminId(auth);
    if (userId === auth.userId) fail("FORBIDDEN", "You can't remove your own access");
    await this.prisma.db.$transaction(async (tx) => {
      // The AdminProfile row stays (audit history references it); with no admin role every admin route is refused.
      const before = await tx.userRole.findMany({ where: { userId, role: { scope: "ADMIN" } }, include: { role: true } });
      await tx.userRole.deleteMany({ where: { userId, role: { scope: "ADMIN" } } });
      await this.admin.audit(adminId, "UserRole", userId, "DELETE", { roles: before.map((b) => b.role.key) }, null, tx);
    });
    await this.redis.client.del(`perms:${userId}`);
    await this.auth.logoutAll(userId);
    return { userId, revoked: true };
  }

  /** For an admin who lost their phone: clears their authenticator and signs them out everywhere. */
  @RequirePermission("rbac:write")
  @Post("admins/:userId/reset-2fa")
  @HttpCode(200)
  async reset2fa(@Auth() auth: AuthContext, @Param("userId") userId: string, @Body(new ZodPipe(ReasonBody)) body: { reason: string }) {
    const adminId = await this.admin.adminId(auth);
    if (userId === auth.userId) fail("FORBIDDEN", "Use your own security page to change your two-factor settings");
    const target = await this.prisma.db.adminProfile.findUnique({ where: { userId } });
    if (!target) fail("NOT_FOUND", "Admin not found");
    await this.prisma.db.adminProfile.update({ where: { userId }, data: { totpEnabledAt: null, totpSecretEnc: null, recoveryCodesHash: [] } });
    await this.redis.client.del(`mfa:enabled:${userId}`);
    await this.auth.logoutAll(userId);
    await this.admin.action(adminId, "admins.reset_2fa", "AdminProfile", target!.id, body.reason);
    return { userId, twoFactor: false };
  }
}
