import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { kobo } from "@zuma/contracts";
import { z } from "zod";
import { fail } from "../../common/errors";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { PrismaService } from "../../infra/prisma.service";
import { RequirePermission } from "../auth/auth.guard";
import { AdminContext, page, pageArgs } from "./admin.support";

const PriceBody = z.object({
  serviceAreaId: z.string(),
  categoryKey: z.string(),
  baseFare: kobo, perKm: kobo, perMinute: kobo, minFare: kobo, maxFare: kobo, minFarePerKm: kobo,
  cancellationFeePassenger: kobo,
  commissionBps: z.number().int().min(0).max(5000),
  requestTtlSeconds: z.number().int().min(60).max(900),
  offerTtlSeconds: z.number().int().min(15).max(300),
  changeReason: z.string().trim().min(5).max(300),
});

const AreaBody = z.object({
  status: z.enum(["ACTIVE", "PAUSED", "RESTRICTED"]).optional(),
  searchRadiusM: z.number().int().min(500).max(20000).optional(),
  maxSearchRadiusM: z.number().int().min(1000).max(50000).optional(),
  radiusStepM: z.number().int().min(250).max(10000).optional(),
  reason: z.string().trim().min(5).max(300),
});

const CategoryToggle = z.object({ isEnabled: z.boolean(), reason: z.string().trim().min(5).max(300) });

const PRICE_FIELDS = ["baseFare", "perKm", "perMinute", "minFare", "maxFare", "minFarePerKm", "cancellationFeePassenger"] as const;

@Controller("v1/admin")
export class AdminConfigController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminContext,
  ) {}

  @RequirePermission("dashboard:read")
  @Get("config/areas")
  async areas() {
    const cities = await this.prisma.db.city.findMany({
      include: {
        serviceAreas: { orderBy: { name: "asc" } },
        vehicleCategories: { include: { category: true }, orderBy: { category: { sortOrder: "asc" } } },
      },
      orderBy: { name: "asc" },
    });
    return cities.map((c) => ({
      id: c.id, key: c.key, name: c.name, isLive: c.isLive, emergencyNumbers: (c.supportContacts as { emergencyNumbers?: string[] } | null)?.emergencyNumbers ?? [],
      areas: c.serviceAreas.map((a) => ({ id: a.id, name: a.name, status: a.status, searchRadiusM: a.searchRadiusM, maxSearchRadiusM: a.maxSearchRadiusM, radiusStepM: a.radiusStepM, restrictedCategoryKeys: a.restrictedCategoryKeys })),
      categories: c.vehicleCategories.map((v) => ({ categoryId: v.categoryId, key: v.category.key, name: v.category.name, seats: v.category.seats, minYear: v.category.minYear, isEnabled: v.isEnabled, legalNote: v.legalNote })),
    }));
  }

  @RequirePermission("config:write")
  @Patch("config/areas/:id")
  async updateArea(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(AreaBody)) body: z.infer<typeof AreaBody>) {
    const adminId = await this.admin.adminId(auth);
    const before = await this.prisma.db.serviceArea.findUnique({ where: { id }, select: { status: true, searchRadiusM: true, maxSearchRadiusM: true, radiusStepM: true } });
    if (!before) fail("NOT_FOUND", "Service area not found");
    const { reason, ...data } = body;
    const max = data.maxSearchRadiusM ?? before!.maxSearchRadiusM;
    const start = data.searchRadiusM ?? before!.searchRadiusM;
    if (start > max) fail("VALIDATION_FAILED", "The starting radius can't be larger than the maximum radius");
    const after = await this.prisma.db.$transaction(async (tx) => {
      const a = await tx.serviceArea.update({ where: { id }, data, select: { status: true, searchRadiusM: true, maxSearchRadiusM: true, radiusStepM: true } });
      await this.admin.audit(adminId, "ServiceArea", id, "UPDATE", before, { ...a, reason }, tx);
      return a;
    });
    return { id, ...after };
  }

  @RequirePermission("config:write")
  @Patch("config/cities/:cityId/categories/:categoryId")
  async toggleCategory(@Auth() auth: AuthContext, @Param("cityId") cityId: string, @Param("categoryId") categoryId: string, @Body(new ZodPipe(CategoryToggle)) body: { isEnabled: boolean; reason: string }) {
    const adminId = await this.admin.adminId(auth);
    const before = await this.prisma.db.cityVehicleCategory.findUnique({ where: { cityId_categoryId: { cityId, categoryId } }, include: { category: true } });
    if (!before) fail("NOT_FOUND", "Category not configured for this city");
    if (body.isEnabled) {
      const pricing = await this.prisma.db.pricingConfiguration.count({ where: { categoryId, effectiveTo: null, serviceArea: { cityId } } });
      if (!pricing) fail("VALIDATION_FAILED", `Add pricing for ${before!.category.name} before enabling it`);
    }
    await this.prisma.db.$transaction(async (tx) => {
      await tx.cityVehicleCategory.update({ where: { cityId_categoryId: { cityId, categoryId } }, data: { isEnabled: body.isEnabled } });
      await this.admin.audit(adminId, "CityVehicleCategory", `${cityId}:${categoryId}`, "UPDATE", { isEnabled: before!.isEnabled }, { isEnabled: body.isEnabled, reason: body.reason }, tx);
    });
    return { cityId, categoryId, isEnabled: body.isEnabled };
  }

  // ---------------- pricing ----------------

  @RequirePermission("dashboard:read")
  @Get("pricing")
  async pricing(@Query("serviceAreaId") serviceAreaId?: string) {
    const area = serviceAreaId
      ? await this.prisma.db.serviceArea.findUnique({ where: { id: serviceAreaId } })
      : await this.prisma.db.serviceArea.findFirst({ orderBy: { createdAt: "asc" } });
    if (!area) fail("NOT_FOUND", "No service area");
    const [active, history] = await Promise.all([
      this.prisma.db.pricingConfiguration.findMany({ where: { serviceAreaId: area!.id, effectiveTo: null }, include: { category: true }, orderBy: { category: { sortOrder: "asc" } } }),
      this.prisma.db.pricingConfiguration.findMany({ where: { serviceAreaId: area!.id }, include: { category: true, createdBy: { include: { user: true } } }, orderBy: { createdAt: "desc" }, take: 40 }),
    ]);
    const toView = (p: (typeof active)[number]) => ({
      id: p.id, categoryKey: p.category.key, categoryName: p.category.name, version: p.version,
      ...Object.fromEntries(PRICE_FIELDS.map((f) => [f, p[f].toString()])),
      commissionBps: p.commissionBps, requestTtlSeconds: p.requestTtlSeconds, offerTtlSeconds: p.offerTtlSeconds,
      effectiveFrom: p.effectiveFrom.toISOString(),
    });
    return {
      serviceArea: { id: area!.id, name: area!.name },
      active: active.map(toView),
      history: history.map((h) => ({
        id: h.id, categoryName: h.category.name, version: h.version, changeReason: h.changeReason,
        by: h.createdBy ? `${h.createdBy.user.firstName} ${h.createdBy.user.lastName}`.trim() : "Seed",
        effectiveFrom: h.effectiveFrom.toISOString(), effectiveTo: h.effectiveTo?.toISOString() ?? null, commissionBps: h.commissionBps,
        minFare: h.minFare.toString(), perKm: h.perKm.toString(),
      })),
    };
  }

  /** Never edits a pricing row: closes the active version and inserts the next one (ADR-005). */
  @RequirePermission("pricing:write")
  @Post("pricing")
  async publishPricing(@Auth() auth: AuthContext, @Body(new ZodPipe(PriceBody)) body: z.infer<typeof PriceBody>) {
    const adminId = await this.admin.adminId(auth);
    const category = await this.prisma.db.vehicleCategory.findUnique({ where: { key: body.categoryKey } });
    if (!category) fail("NOT_FOUND", "Category not found");
    const v = Object.fromEntries(PRICE_FIELDS.map((f) => [f, BigInt(body[f])])) as Record<(typeof PRICE_FIELDS)[number], bigint>;
    if (v.minFare <= 0n || v.maxFare <= v.minFare) fail("VALIDATION_FAILED", "The maximum fare must be higher than the minimum fare");
    const created = await this.prisma.db.$transaction(async (tx) => {
      const current = await tx.pricingConfiguration.findFirst({ where: { serviceAreaId: body.serviceAreaId, categoryId: category!.id, effectiveTo: null } });
      const last = await tx.pricingConfiguration.findFirst({ where: { serviceAreaId: body.serviceAreaId, categoryId: category!.id }, orderBy: { version: "desc" } });
      const now = new Date();
      if (current) await tx.pricingConfiguration.update({ where: { id: current.id }, data: { effectiveTo: now } });
      const next = await tx.pricingConfiguration.create({
        data: {
          serviceAreaId: body.serviceAreaId, categoryId: category!.id, version: (last?.version ?? 0) + 1,
          ...v, commissionBps: body.commissionBps, requestTtlSeconds: body.requestTtlSeconds, offerTtlSeconds: body.offerTtlSeconds,
          bookingFee: current?.bookingFee ?? 0n, waitingFreeMinutes: current?.waitingFreeMinutes ?? 3, waitingPerMinute: current?.waitingPerMinute ?? 0n,
          cancellationFeeDriver: current?.cancellationFeeDriver ?? 0n, cancellationGraceSeconds: current?.cancellationGraceSeconds ?? 120,
          maxCounterOfferPctAbove: current?.maxCounterOfferPctAbove ?? 100,
          effectiveFrom: now, createdById: adminId, changeReason: body.changeReason,
        },
      });
      await this.admin.audit(adminId, "PricingConfiguration", next.id, "CREATE", current, next, tx);
      return next;
    });
    return { id: created.id, version: created.version };
  }

  // ---------------- audit ----------------

  @RequirePermission("audit:read")
  @Get("audit")
  async audit(@Query("kind") kind = "actions", @Query("cursor") cursor?: string) {
    const { _take, ...args } = pageArgs(cursor, "50");
    if (kind === "changes") {
      const rows = await this.prisma.db.auditLog.findMany({ ...args, orderBy: { createdAt: "desc" }, include: { admin: { include: { user: true } } } });
      const p = page(rows, _take);
      return { nextCursor: p.nextCursor, data: p.data.map((r) => ({ id: r.id, at: r.createdAt.toISOString(), by: r.admin ? `${r.admin.user.firstName} ${r.admin.user.lastName}`.trim() : r.actorType, entity: r.entity, entityId: r.entityId, operation: r.operation, before: r.before, after: r.after })) };
    }
    const rows = await this.prisma.db.adminActionLog.findMany({ ...args, orderBy: { createdAt: "desc" }, include: { admin: { include: { user: true } } } });
    const p = page(rows, _take);
    return { nextCursor: p.nextCursor, data: p.data.map((r) => ({ id: r.id, at: r.createdAt.toISOString(), by: `${r.admin.user.firstName} ${r.admin.user.lastName}`.trim(), action: r.action, targetType: r.targetType, targetId: r.targetId, reason: r.reason })) };
  }
}
