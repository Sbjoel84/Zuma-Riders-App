import { Injectable } from "@nestjs/common";
import { Money } from "@zuma/contracts";
import type { PromoCode, Promotion } from "@zuma/database";
import { fail } from "../../common/errors";
import { PrismaService, type Tx } from "../../infra/prisma.service";
import { ACTIVE_RIDE_STATUSES } from "../rides/state-machine";

type CodeWithPromotion = PromoCode & { promotion: Promotion };

/**
 * Promo codes. Riders App funds the discount: the passenger pays agreed fare − discount, the driver still
 * earns on the full agreed fare, and the difference is booked to PROMO_EXPENSE at settlement.
 *  - validated when the passenger books (so they see it before searching),
 *  - priced when they accept an offer (the discount is fixed on the ride with the agreed fare),
 *  - redeemed (usage + budget counted) when the trip completes.
 */
@Injectable()
export class PromosService {
  constructor(private readonly prisma: PrismaService) {}

  static describe(c: PromoCode): string {
    const cap = c.maxDiscount ? ` (up to ${Money.format(c.maxDiscount)})` : "";
    const what = c.discountType === "PERCENTAGE" ? `${c.discountValue / 100}% off${cap}` : `${Money.format(BigInt(c.discountValue))} off`;
    return `${what}${c.firstRideOnly ? " your first ride" : " your ride"}${c.minFare ? ` over ${Money.format(c.minFare)}` : ""}`;
  }

  static amount(c: PromoCode, fare: bigint): bigint {
    let d = c.discountType === "PERCENTAGE" ? (fare * BigInt(c.discountValue)) / 10000n : BigInt(c.discountValue);
    if (c.maxDiscount && d > c.maxDiscount) d = c.maxDiscount;
    if (d > fare - 100n) d = fare - 100n; // the passenger always pays something (≥ ₦1)
    return d > 0n ? d : 0n;
  }

  /** Returns a reason the code can't be used, or null. */
  private async problem(db: Tx | PrismaService["db"], c: CodeWithPromotion | null, userId: string, categoryKey?: string, fare?: bigint): Promise<string | null> {
    const now = new Date();
    if (!c || !c.isActive || !c.promotion.isActive) return "That promo code isn't valid";
    if (c.startsAt > now || c.promotion.startsAt > now) return "That promo code isn't active yet";
    if (c.endsAt < now || c.promotion.endsAt < now) return "That promo code has expired";
    if (c.promotion.audience === "DRIVER") return "That promo code isn't valid";
    if (c.usageLimit !== null && c.usedCount >= c.usageLimit) return "That promo code has been fully used";
    if (c.promotion.budget !== null && c.promotion.spent >= c.promotion.budget) return "That promotion has ended";
    if (categoryKey && c.categoryKeys.length && !c.categoryKeys.includes(categoryKey)) return `That code isn't valid for this ride type`;
    if (fare !== undefined && c.minFare && fare < c.minFare) return `That code needs a fare of at least ${Money.format(c.minFare)}`;
    const passenger = await db.passengerProfile.findUnique({ where: { userId } });
    if (c.firstRideOnly && (passenger?.tripsCompleted ?? 0) > 0) return "That code is for your first ride only";
    const used = await db.promoRedemption.count({ where: { promoCodeId: c.id, userId } });
    const inFlight = passenger
      ? await db.ride.count({ where: { passengerId: passenger.id, status: { in: ACTIVE_RIDE_STATUSES }, discountAmount: { gt: 0 }, rideRequest: { promoCodeId: c.id } } })
      : 0;
    if (used + inFlight >= c.perUserLimit) return "You've already used this promo code";
    return null;
  }

  async validate(userId: string, code: string, categoryKey?: string, fare?: bigint) {
    const c = await this.prisma.db.promoCode.findUnique({ where: { code: code.trim() }, include: { promotion: true } });
    const why = await this.problem(this.prisma.db, c, userId, categoryKey, fare);
    if (why) fail("PROMO_INVALID", why);
    return {
      code: c!.code, promoCodeId: c!.id, description: PromosService.describe(c!),
      discountType: c!.discountType, discountValue: c!.discountValue, maxDiscount: c!.maxDiscount?.toString() ?? null,
      estimatedDiscount: fare !== undefined ? PromosService.amount(c!, fare).toString() : null,
    };
  }

  /** Discount for an accepted offer, inside the acceptance transaction. 0 if the code stopped being valid. */
  async discountFor(tx: Tx, promoCodeId: string | null, userId: string, categoryKey: string, fare: bigint): Promise<bigint> {
    if (!promoCodeId) return 0n;
    const c = await tx.promoCode.findUnique({ where: { id: promoCodeId }, include: { promotion: true } });
    if (await this.problem(tx, c, userId, categoryKey, fare)) return 0n;
    let d = PromosService.amount(c!, fare);
    if (c!.promotion.budget !== null) {
      const left = c!.promotion.budget - c!.promotion.spent;
      if (d > left) d = left > 0n ? left : 0n;
    }
    return d;
  }

  /** Inside the completion transaction. The ride's unique redemption row makes this once-only. */
  async redeem(tx: Tx, ride: { id: string; discountAmount: bigint }, promoCodeId: string | null, userId: string) {
    if (!promoCodeId || ride.discountAmount <= 0n) return;
    const exists = await tx.promoRedemption.findUnique({ where: { rideId: ride.id } });
    if (exists) return;
    const c = await tx.promoCode.update({ where: { id: promoCodeId }, data: { usedCount: { increment: 1 } } });
    await tx.promotion.update({ where: { id: c.promotionId }, data: { spent: { increment: ride.discountAmount } } });
    await tx.promoRedemption.create({ data: { promoCodeId, userId, rideId: ride.id, amount: ride.discountAmount } });
  }
}
