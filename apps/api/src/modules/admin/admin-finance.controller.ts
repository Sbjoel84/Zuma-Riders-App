import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { kobo } from "@zuma/contracts";
import type { Prisma, WithdrawalStatus } from "@zuma/database";
import { randomUUID } from "crypto";
import { z } from "zod";
import { fail } from "../../common/errors";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { PrismaService } from "../../infra/prisma.service";
import { RequirePermission } from "../auth/auth.guard";
import { LedgerService } from "../ledger/ledger.service";
import { WalletService } from "../ledger/wallet.service";
import { WithdrawalsService } from "../ledger/withdrawals.service";
import { AdminContext, lagosDayStart, page, pageArgs } from "./admin.support";

const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) });
const PaidBody = z.object({ bankReference: z.string().trim().min(3).max(100) });
const AdjustBody = z.object({
  ownerType: z.enum(["PASSENGER", "DRIVER"]),
  direction: z.enum(["CREDIT", "DEBIT"]),
  amount: kobo,
  reason: z.string().trim().min(5).max(300),
});

const name = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();

@Controller("v1/admin/finance")
export class AdminFinanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletService,
    private readonly withdrawals: WithdrawalsService,
    private readonly admin: AdminContext,
  ) {}

  @RequirePermission("finance:read")
  @Get("summary")
  async summary(@Query("days") daysStr?: string) {
    const days = Math.min(90, Math.max(1, parseInt(daysStr ?? "1", 10) || 1));
    const from = lagosDayStart(days - 1);
    const db = this.prisma.db;
    const [gross, cash, wallet, commission, cancelFees, trips] = await Promise.all([
      db.ride.aggregate({ _sum: { finalFare: true }, where: { status: "TRIP_COMPLETED", completedAt: { gte: from } } }),
      db.ride.aggregate({ _sum: { finalFare: true }, where: { status: "TRIP_COMPLETED", completedAt: { gte: from }, paymentMethod: "CASH" } }),
      db.ride.aggregate({ _sum: { finalFare: true }, where: { status: "TRIP_COMPLETED", completedAt: { gte: from }, paymentMethod: "WALLET" } }),
      db.commission.aggregate({ _sum: { amount: true }, where: { createdAt: { gte: from } } }),
      db.rideCancellation.aggregate({ _sum: { feeAmount: true }, where: { createdAt: { gte: from }, feeWaived: false } }),
      db.ride.count({ where: { status: "TRIP_COMPLETED", completedAt: { gte: from } } }),
    ]);
    const byType = await db.wallet.groupBy({ by: ["ownerType"], _sum: { availableBalance: true, pendingBalance: true, heldBalance: true } });
    const pos = await db.wallet.groupBy({ by: ["ownerType"], where: { availableBalance: { gt: 0 } }, _sum: { availableBalance: true } });
    const owed = await db.wallet.aggregate({ _sum: { availableBalance: true }, _count: true, where: { ownerType: "DRIVER", availableBalance: { lt: 0 } } });
    const liab = (t: "PASSENGER" | "DRIVER") => {
      const g = byType.find((b) => b.ownerType === t)?._sum;
      const p = pos.find((b) => b.ownerType === t)?._sum.availableBalance ?? 0n;
      return p + (g?.pendingBalance ?? 0n) + (g?.heldBalance ?? 0n);
    };
    const pendingWd = await db.withdrawal.aggregate({ _sum: { amount: true }, _count: true, where: { status: { in: ["REQUESTED", "APPROVED"] } } });
    const unbalanced = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM (SELECT "transactionId" FROM "LedgerEntry" GROUP BY "transactionId"
      HAVING SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) <> 0) x`;
    const drift = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM "Wallet" w
      WHERE w."availableBalance" <> COALESCE((SELECT SUM(CASE WHEN e.direction='CREDIT' THEN e.amount ELSE -e.amount END) FROM "LedgerEntry" e JOIN "LedgerAccount" a ON a.id=e."accountId" WHERE a."walletId"=w.id AND a.purpose='WALLET_AVAILABLE'),0)`;
    return {
      days, trips,
      gross: (gross._sum.finalFare ?? 0n).toString(),
      cashGross: (cash._sum.finalFare ?? 0n).toString(),
      walletGross: (wallet._sum.finalFare ?? 0n).toString(),
      commission: (commission._sum.amount ?? 0n).toString(),
      cancellationFees: (cancelFees._sum.feeAmount ?? 0n).toString(),
      passengerLiability: liab("PASSENGER").toString(),
      driverLiability: liab("DRIVER").toString(),
      cashCommissionOwed: (-(owed._sum.availableBalance ?? 0n)).toString(),
      driversOwing: owed._count,
      pendingWithdrawals: { count: pendingWd._count, amount: (pendingWd._sum.amount ?? 0n).toString() },
      integrity: { unbalancedTransactions: Number(unbalanced[0]?.n ?? 0), walletsOutOfSync: Number(drift[0]?.n ?? 0) },
    };
  }

  @RequirePermission("finance:read")
  @Get("ledger")
  async journal(@Query("cursor") cursor?: string, @Query("limit") limit?: string, @Query("type") type?: string) {
    const { _take, ...args } = pageArgs(cursor, limit ?? "30");
    const rows = await this.prisma.db.ledgerTransaction.findMany({
      where: type ? { type: type as never } : {},
      ...args, orderBy: { postedAt: "desc" },
      include: { entries: { include: { account: { include: { wallet: { include: { user: true } } } } } } },
    });
    const p = page(rows, _take);
    return {
      nextCursor: p.nextCursor,
      data: p.data.map((t) => ({
        id: t.id, type: t.type, description: t.description, postedAt: t.postedAt.toISOString(), rideId: t.rideId,
        entries: t.entries.map((e) => ({
          account: e.account.wallet ? `${name(e.account.wallet.user)} · ${e.account.wallet.ownerType.toLowerCase()} ${e.account.purpose.replace("WALLET_", "").toLowerCase()}` : e.account.purpose.replace(/_/g, " ").toLowerCase(),
          code: e.account.code, direction: e.direction, amount: e.amount.toString(),
        })),
      })),
    };
  }

  @RequirePermission("finance:read")
  @Get("withdrawals")
  async listWithdrawals(@Query("status") status?: string) {
    const where: Prisma.WithdrawalWhereInput = status === "open" ? { status: { in: ["REQUESTED", "APPROVED"] } } : status ? { status: status as WithdrawalStatus } : {};
    const rows = await this.prisma.db.withdrawal.findMany({ where, orderBy: { createdAt: "desc" }, take: 100, include: { wallet: { include: { user: true } }, approvedBy: { include: { user: true } } } });
    return rows.map((w) => ({
      id: w.id, driver: name(w.wallet.user), phone: w.wallet.user.phoneE164, amount: w.amount.toString(), bank: `${w.bankName} ••${w.bankAccountLast4}`,
      status: w.status, rejectionReason: w.rejectionReason, bankReference: w.providerRef, approvedBy: w.approvedBy ? name(w.approvedBy.user) : null,
      createdAt: w.createdAt.toISOString(), completedAt: w.completedAt?.toISOString() ?? null, availableAfter: w.wallet.availableBalance.toString(),
    }));
  }

  @RequirePermission("finance:payout")
  @Post("withdrawals/:id/approve")
  @HttpCode(200)
  async approve(@Auth() auth: AuthContext, @Param("id") id: string) {
    const adminId = await this.admin.adminId(auth);
    await this.withdrawals.approve(id, adminId);
    await this.admin.action(adminId, "withdrawals.approve", "Withdrawal", id);
    return { id, status: "APPROVED" };
  }

  @RequirePermission("finance:payout")
  @Post("withdrawals/:id/reject")
  @HttpCode(200)
  async reject(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(ReasonBody)) body: { reason: string }) {
    const adminId = await this.admin.adminId(auth);
    await this.withdrawals.reject(id, adminId, body.reason);
    await this.admin.action(adminId, "withdrawals.reject", "Withdrawal", id, body.reason);
    return { id, status: "REJECTED" };
  }

  @RequirePermission("finance:payout")
  @Post("withdrawals/:id/paid")
  @HttpCode(200)
  async paid(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(PaidBody)) body: { bankReference: string }) {
    const adminId = await this.admin.adminId(auth);
    await this.withdrawals.markPaid(id, adminId, body.bankReference);
    await this.admin.action(adminId, "withdrawals.paid", "Withdrawal", id, body.bankReference);
    return { id, status: "COMPLETED" };
  }

  /** Wallet lookup by phone for adjustments. */
  @RequirePermission("finance:read")
  @Get("wallets")
  async findWallets(@Query("q") q = "") {
    const s = q.trim().replace(/^0/, "");
    if (s.length < 3) return [];
    const users = await this.prisma.db.user.findMany({
      where: { OR: [{ phoneE164: { contains: s } }, { firstName: { contains: q.trim(), mode: "insensitive" } }, { lastName: { contains: q.trim(), mode: "insensitive" } }] },
      include: { wallets: true }, take: 10,
    });
    return users.flatMap((u) => u.wallets.map((w) => ({ userId: u.id, name: name(u), phone: u.phoneE164, ownerType: w.ownerType, available: w.availableBalance.toString(), pending: w.pendingBalance.toString(), held: w.heldBalance.toString() })));
  }

  /**
   * Manual adjustment: cash top-up paid at the driver hub, goodwill credit, or a correction.
   * Posts a balanced ADJUSTMENT against the suspense account and records it in the audit log.
   */
  @RequirePermission("finance:adjust")
  @Post("wallets/:userId/adjust")
  @HttpCode(200)
  async adjust(@Auth() auth: AuthContext, @Param("userId") userId: string, @Body(new ZodPipe(AdjustBody)) body: z.infer<typeof AdjustBody>) {
    const adminId = await this.admin.adminId(auth);
    const amount = BigInt(body.amount);
    if (amount <= 0n || amount > 50_000_000n) fail("VALIDATION_FAILED", "Adjustments must be between ₦0.01 and ₦500,000");
    const user = await this.prisma.db.user.findUnique({ where: { id: userId } });
    if (!user) fail("NOT_FOUND", "User not found");
    const before = await this.wallets.ensureWallet(userId, body.ownerType);
    const result = await this.prisma.db.$transaction(async (tx) => {
      const userAcct = await this.wallets.accountId(userId, body.ownerType, "WALLET_AVAILABLE", tx);
      const suspense = await this.wallets.systemAccountId("SUSPENSE", tx);
      const posted = await this.ledger.post(tx, {
        type: "ADJUSTMENT", idempotencyKey: `adjust:${randomUUID()}`, description: `Adjustment: ${body.reason}`, createdByType: "ADMIN", createdById: auth.userId,
        entries: body.direction === "CREDIT"
          ? [{ accountId: suspense, direction: "DEBIT", amount }, { accountId: userAcct, direction: "CREDIT", amount }]
          : [{ accountId: userAcct, direction: "DEBIT", amount }, { accountId: suspense, direction: "CREDIT", amount }],
      });
      const after = await tx.wallet.findUniqueOrThrow({ where: { id: before.id } });
      await this.admin.audit(adminId, "Wallet", before.id, "UPDATE", { availableBalance: before.availableBalance }, { availableBalance: after.availableBalance, direction: body.direction, amount, reason: body.reason, ledgerTransactionId: posted.id }, tx);
      return after;
    });
    await this.admin.action(adminId, `wallets.${body.direction.toLowerCase()}`, "Wallet", before.id, body.reason);
    return { userId, ownerType: body.ownerType, availableBalance: result.availableBalance.toString() };
  }
}
