import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { kobo } from "@zuma/contracts";
import { z } from "zod";
import { fail } from "../../common/errors";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { env } from "../../config/env";
import { isUniqueViolation, PrismaService } from "../../infra/prisma.service";
import { RequirePermission } from "../auth/auth.guard";
import { PromosService } from "../promos/promos.service";
import { AdminContext } from "./admin.support";

const PromoBody = z
  .object({
    name: z.string().trim().min(3).max(80),
    description: z.string().trim().max(300).optional(),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4,20}$/, "Codes are 4–20 letters or digits"),
    discountType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]),
    /** Percent (1–100) for PERCENTAGE, kobo for FIXED_AMOUNT. */
    discountValue: z.number().positive(),
    maxDiscount: kobo.optional(),
    minFare: kobo.optional(),
    usageLimit: z.number().int().positive().optional(),
    perUserLimit: z.number().int().min(1).max(50).default(1),
    firstRideOnly: z.boolean().default(false),
    categoryKeys: z.array(z.string()).default([]),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    budget: kobo.optional(),
  })
  .refine((b) => new Date(b.endsAt) > new Date(b.startsAt), { message: "The end date must be after the start date", path: ["endsAt"] })
  .refine((b) => b.discountType !== "PERCENTAGE" || b.discountValue <= 100, { message: "Percentages go up to 100", path: ["discountValue"] });
const ActiveBody = z.object({ isActive: z.boolean() });

const name = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim() || "(no name yet)";

@Controller("v1/admin")
export class AdminGrowthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminContext,
  ) {}

  @RequirePermission("marketing:write")
  @Get("promotions")
  async promotions() {
    const rows = await this.prisma.db.promotion.findMany({ orderBy: { createdAt: "desc" }, include: { promoCodes: true } });
    const now = new Date();
    return rows.map((p) => ({
      id: p.id, name: p.name, description: p.description, isActive: p.isActive, startsAt: p.startsAt.toISOString(), endsAt: p.endsAt.toISOString(),
      budget: p.budget?.toString() ?? null, spent: p.spent.toString(),
      state: !p.isActive ? "PAUSED" : p.endsAt < now ? "ENDED" : p.startsAt > now ? "SCHEDULED" : p.budget !== null && p.spent >= p.budget ? "BUDGET_USED" : "LIVE",
      codes: p.promoCodes.map((c) => ({
        id: c.id, code: c.code, description: PromosService.describe(c), discountType: c.discountType, discountValue: c.discountValue,
        maxDiscount: c.maxDiscount?.toString() ?? null, minFare: c.minFare?.toString() ?? null, usageLimit: c.usageLimit, usedCount: c.usedCount,
        perUserLimit: c.perUserLimit, firstRideOnly: c.firstRideOnly, categoryKeys: c.categoryKeys,
      })),
    }));
  }

  /** One promotion with one code: the common case. */
  @RequirePermission("marketing:write")
  @Post("promotions")
  async create(@Auth() auth: AuthContext, @Body(new ZodPipe(PromoBody)) b: z.infer<typeof PromoBody>) {
    const adminId = await this.admin.adminId(auth);
    if (b.discountType === "FIXED_AMOUNT" && !Number.isInteger(b.discountValue)) fail("VALIDATION_FAILED", "Fixed discounts are in kobo");
    const city = await this.prisma.db.city.findFirst({ where: { isLive: true } });
    try {
      const p = await this.prisma.db.$transaction(async (tx) => {
        const promo = await tx.promotion.create({
          data: { name: b.name, description: b.description, audience: "PASSENGER", cityId: city?.id, budget: b.budget ? BigInt(b.budget) : null, startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt) },
        });
        await tx.promoCode.create({
          data: {
            promotionId: promo.id, code: b.code, discountType: b.discountType,
            discountValue: b.discountType === "PERCENTAGE" ? Math.round(b.discountValue * 100) : b.discountValue,
            maxDiscount: b.maxDiscount ? BigInt(b.maxDiscount) : null, minFare: b.minFare ? BigInt(b.minFare) : null,
            usageLimit: b.usageLimit, perUserLimit: b.perUserLimit, firstRideOnly: b.firstRideOnly, categoryKeys: b.categoryKeys,
            startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt),
          },
        });
        await this.admin.audit(adminId, "Promotion", promo.id, "CREATE", null, b, tx);
        return promo;
      });
      await this.admin.action(adminId, "promotions.create", "Promotion", p.id, b.code);
      return { id: p.id };
    } catch (e) {
      if (isUniqueViolation(e)) fail("VALIDATION_FAILED", "That code already exists");
      throw e;
    }
  }

  @RequirePermission("marketing:write")
  @Post("promotions/:id/active")
  @HttpCode(200)
  async setActive(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(ActiveBody)) body: { isActive: boolean }) {
    const adminId = await this.admin.adminId(auth);
    const p = await this.prisma.db.promotion.findUnique({ where: { id } });
    if (!p) fail("NOT_FOUND", "Promotion not found");
    await this.prisma.db.promotion.update({ where: { id }, data: { isActive: body.isActive } });
    await this.prisma.db.promoCode.updateMany({ where: { promotionId: id }, data: { isActive: body.isActive } });
    await this.admin.audit(adminId, "Promotion", id, "UPDATE", { isActive: p!.isActive }, { isActive: body.isActive });
    await this.admin.action(adminId, body.isActive ? "promotions.resume" : "promotions.pause", "Promotion", id);
    return { id, isActive: body.isActive };
  }

  @RequirePermission("marketing:write")
  @Get("promotions/:id/redemptions")
  async redemptions(@Param("id") id: string) {
    const rows = await this.prisma.db.promoRedemption.findMany({ where: { promoCode: { promotionId: id } }, orderBy: { createdAt: "desc" }, take: 100, include: { user: true, ride: { select: { id: true, code: true } }, promoCode: true } });
    return rows.map((r) => ({ id: r.id, code: r.promoCode.code, user: name(r.user), phone: r.user.phoneE164, amount: r.amount.toString(), ride: r.ride, createdAt: r.createdAt.toISOString() }));
  }

  @RequirePermission("marketing:write")
  @Get("referrals")
  async referrals() {
    const rows = await this.prisma.db.referral.findMany({ orderBy: { createdAt: "desc" }, take: 200, include: { referrer: true, referee: true, rewards: true } });
    const paid = await this.prisma.db.referralReward.aggregate({ _sum: { amount: true }, where: { paidAt: { not: null } } });
    return {
      rewards: { passenger: env().REFERRAL_REWARD_PASSENGER_KOBO.toString(), driver: env().REFERRAL_REWARD_DRIVER_KOBO.toString(), driverTrips: env().REFERRAL_DRIVER_TRIPS },
      totalPaid: (paid._sum.amount ?? 0n).toString(),
      data: rows.map((r) => ({
        id: r.id, referrer: name(r.referrer), referrerPhone: r.referrer.phoneE164, referee: name(r.referee), refereePhone: r.referee.phoneE164,
        role: r.refereeRole, status: r.status, fraudSignals: r.fraudSignals, paid: r.rewards.reduce((s, x) => s + (x.paidAt ? x.amount : 0n), 0n).toString(),
        createdAt: r.createdAt.toISOString(), qualifiedAt: r.qualifiedAt?.toISOString() ?? null,
      })),
    };
  }
}
