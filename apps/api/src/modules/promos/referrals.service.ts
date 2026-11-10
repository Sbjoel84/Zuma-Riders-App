import { Injectable } from "@nestjs/common";
import { Money } from "@zuma/contracts";
import type { Prisma, WalletOwnerType } from "@zuma/database";
import { env } from "../../config/env";
import { PrismaService, type Tx } from "../../infra/prisma.service";
import { LedgerService } from "../ledger/ledger.service";
import { WalletService } from "../ledger/wallet.service";

export interface RewardPaid {
  userId: string;
  amount: bigint;
  text: string;
}

/**
 * Referral rewards, paid as wallet credit from REFERRAL_EXPENSE:
 *  - passenger invites passenger: both get REFERRAL_REWARD_PASSENGER_KOBO after the new rider's first completed trip;
 *  - driver invites driver: the referrer gets REFERRAL_REWARD_DRIVER_KOBO after the new driver's Nth trip.
 * Referrals where both accounts signed in on the same phone are rejected as fraud.
 */
@Injectable()
export class ReferralsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletService,
  ) {}

  /** Called inside the trip-completion transaction for both parties. Returns rewards to announce after commit. */
  async onTripCompleted(tx: Tx, userId: string, role: "PASSENGER" | "DRIVER", tripsCompleted: number): Promise<RewardPaid[]> {
    const ref = await tx.referral.findUnique({ where: { refereeId: userId }, include: { referrer: { include: { driver: true } }, referee: true } });
    if (!ref || ref.status !== "PENDING" || ref.refereeRole !== role) return [];
    const needed = role === "DRIVER" ? env().REFERRAL_DRIVER_TRIPS : 1;
    if (tripsCompleted < needed) return [];

    const [a, b] = await Promise.all([
      tx.device.findMany({ where: { userId: ref.referrerId }, select: { installId: true } }),
      tx.device.findMany({ where: { userId }, select: { installId: true } }),
    ]);
    const shared = a.map((d) => d.installId).filter((id) => b.some((x) => x.installId === id));
    if (shared.length) {
      await tx.referral.update({ where: { id: ref.id }, data: { status: "REJECTED_FRAUD", fraudSignals: { sameDevice: shared } as Prisma.InputJsonValue } });
      return [];
    }

    await tx.referral.update({ where: { id: ref.id }, data: { status: "REWARDED", qualifiedAt: new Date(), qualifyingRule: { completedTrips: needed } } });
    const paid: RewardPaid[] = [];
    const pay = async (beneficiary: string, owner: WalletOwnerType, amount: bigint, text: string) => {
      if (amount <= 0n) return;
      const reward = await tx.referralReward.create({ data: { referralId: ref.id, beneficiaryUserId: beneficiary, amount } });
      const posted = await this.ledger.post(tx, {
        type: "REFERRAL_REWARD", idempotencyKey: `referral:${ref.id}:${beneficiary}`, description: text, createdByType: "SYSTEM",
        entries: [
          { accountId: await this.wallets.systemAccountId("REFERRAL_EXPENSE", tx), direction: "DEBIT", amount },
          { accountId: await this.wallets.accountId(beneficiary, owner, "WALLET_AVAILABLE", tx), direction: "CREDIT", amount },
        ],
      });
      await tx.referralReward.update({ where: { id: reward.id }, data: { ledgerTransactionId: posted.id, paidAt: new Date() } });
      paid.push({ userId: beneficiary, amount, text });
    };
    const friend = ref.referee.firstName || "Your friend";
    if (role === "PASSENGER") {
      const amt = env().REFERRAL_REWARD_PASSENGER_KOBO;
      await pay(ref.referrerId, "PASSENGER", amt, `Referral reward: ${friend} took their first Zuma ride`);
      await pay(userId, "PASSENGER", amt, "Welcome reward for joining with a referral code");
    } else {
      const owner: WalletOwnerType = ref.referrer.driver ? "DRIVER" : "PASSENGER";
      await pay(ref.referrerId, owner, env().REFERRAL_REWARD_DRIVER_KOBO, `Referral reward: ${friend} completed ${needed} trips`);
    }
    return paid;
  }

  async summary(userId: string, scope: "PASSENGER" | "DRIVER") {
    const u = await this.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
    const rows = await this.prisma.db.referral.findMany({ where: { referrerId: userId }, include: { referee: true, rewards: true }, orderBy: { createdAt: "desc" }, take: 50 });
    const earned = rows.flatMap((r) => r.rewards.filter((x) => x.beneficiaryUserId === userId && x.paidAt)).reduce((s, x) => s + x.amount, 0n);
    const reward = scope === "DRIVER" ? env().REFERRAL_REWARD_DRIVER_KOBO : env().REFERRAL_REWARD_PASSENGER_KOBO;
    return {
      code: u.referralCode,
      reward: reward.toString(),
      howItWorks: scope === "DRIVER"
        ? `Invite drivers with your code. When they complete ${env().REFERRAL_DRIVER_TRIPS} trips, you get ${Money.format(env().REFERRAL_REWARD_DRIVER_KOBO)}.`
        : `Give friends your code. When they finish their first ride, you both get ${Money.format(reward)} in your Zuma wallet.`,
      earned: earned.toString(),
      referrals: rows.map((r) => ({
        name: r.referee.firstName ? `${r.referee.firstName} ${r.referee.lastName.slice(0, 1)}.`.trim() : "New user",
        status: r.status === "REJECTED_FRAUD" ? "NOT_ELIGIBLE" : r.status,
        joinedAt: r.createdAt.toISOString(),
      })),
    };
  }
}
