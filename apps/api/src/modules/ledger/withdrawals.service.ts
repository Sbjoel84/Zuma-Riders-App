import { Injectable } from "@nestjs/common";
import { DomainError, fail } from "../../common/errors";
import { PrismaService } from "../../infra/prisma.service";
import { LedgerService } from "./ledger.service";
import { WalletService } from "./wallet.service";

export const MIN_WITHDRAWAL = 100_000n; // ₦1,000

/**
 * Driver payouts. Until Paystack/Flutterwave transfers are integrated, payouts are manual: finance
 * approves, sends the bank transfer, then records it as paid with the bank reference.
 *   request  → DR available, CR held
 *   reject   → DR held, CR available
 *   paid     → DR held, CR bank-payout clearing
 */
@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletService,
  ) {}

  async request(userId: string, amount: bigint, idempotencyKey: string) {
    if (amount < MIN_WITHDRAWAL) fail("VALIDATION_FAILED", "The minimum withdrawal is ₦1,000");
    const driver = await this.prisma.db.driver.findUnique({ where: { userId } });
    if (!driver) fail("DRIVER_NOT_VERIFIED", "Finish driver registration first");
    if (!driver!.bankAccountLast4 || !driver!.bankName) fail("VALIDATION_FAILED", "Add your bank account before withdrawing");
    const existing = await this.prisma.db.withdrawal.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;
    const wallet = await this.wallets.ensureWallet(userId, "DRIVER");

    return this.prisma.db.$transaction(async (tx) => {
      const [w] = await tx.$queryRaw<Array<{ availableBalance: bigint; isFrozen: boolean }>>`SELECT "availableBalance", "isFrozen" FROM "Wallet" WHERE id = ${wallet.id} FOR UPDATE`;
      if (w!.isFrozen) throw new DomainError("FORBIDDEN", "Your wallet is frozen. Contact support.");
      if (w!.availableBalance < amount) throw new DomainError("WALLET_INSUFFICIENT", "You can't withdraw more than your available balance");
      const open = await tx.withdrawal.count({ where: { walletId: wallet.id, status: { in: ["REQUESTED", "APPROVED", "PROCESSING"] } } });
      if (open > 0) throw new DomainError("VALIDATION_FAILED", "You already have a withdrawal in progress");
      const wd = await tx.withdrawal.create({
        data: {
          walletId: wallet.id, idempotencyKey, amount, bankName: driver!.bankName!, bankAccountLast4: driver!.bankAccountLast4!,
          recipientCode: driver!.payoutRecipientCode ?? "MANUAL", provider: "NONE", status: "REQUESTED",
        },
      });
      await this.ledger.post(tx, {
        type: "WITHDRAWAL_HOLD", idempotencyKey: `withdrawal-hold:${wd.id}`, description: "Withdrawal requested", createdByType: "DRIVER", createdById: userId,
        entries: [
          { accountId: await this.wallets.accountId(userId, "DRIVER", "WALLET_AVAILABLE", tx), direction: "DEBIT", amount },
          { accountId: await this.wallets.accountId(userId, "DRIVER", "WALLET_HELD", tx), direction: "CREDIT", amount },
        ],
      });
      return wd;
    });
  }

  async list(userId: string) {
    const w = await this.wallets.ensureWallet(userId, "DRIVER");
    const rows = await this.prisma.db.withdrawal.findMany({ where: { walletId: w.id }, orderBy: { createdAt: "desc" }, take: 30 });
    return rows.map((r) => ({ id: r.id, amount: r.amount.toString(), status: r.status, bank: `${r.bankName} ••${r.bankAccountLast4}`, rejectionReason: r.rejectionReason, createdAt: r.createdAt.toISOString(), completedAt: r.completedAt?.toISOString() ?? null }));
  }

  async approve(id: string, adminId: string) {
    const c = await this.prisma.db.withdrawal.updateMany({ where: { id, status: "REQUESTED" }, data: { status: "APPROVED", approvedById: adminId, approvedAt: new Date() } });
    if (!c.count) fail("INVALID_STATE_TRANSITION", "Only requested withdrawals can be approved");
  }

  async reject(id: string, adminId: string, reason: string) {
    await this.prisma.db.$transaction(async (tx) => {
      const c = await tx.withdrawal.updateMany({ where: { id, status: { in: ["REQUESTED", "APPROVED"] } }, data: { status: "REJECTED", rejectionReason: reason, approvedById: adminId } });
      if (!c.count) throw new DomainError("INVALID_STATE_TRANSITION", "This withdrawal can no longer be rejected");
      const wd = await tx.withdrawal.findUniqueOrThrow({ where: { id }, include: { wallet: true } });
      await this.ledger.post(tx, {
        type: "WITHDRAWAL_RELEASE", idempotencyKey: `withdrawal-release:${id}`, description: `Withdrawal rejected: ${reason}`, createdByType: "ADMIN", createdById: adminId,
        entries: [
          { accountId: await this.wallets.accountId(wd.wallet.userId, "DRIVER", "WALLET_HELD", tx), direction: "DEBIT", amount: wd.amount },
          { accountId: await this.wallets.accountId(wd.wallet.userId, "DRIVER", "WALLET_AVAILABLE", tx), direction: "CREDIT", amount: wd.amount },
        ],
      });
    });
  }

  async markPaid(id: string, adminId: string, bankReference: string) {
    await this.prisma.db.$transaction(async (tx) => {
      const c = await tx.withdrawal.updateMany({ where: { id, status: "APPROVED" }, data: { status: "COMPLETED", providerRef: bankReference, completedAt: new Date() } });
      if (!c.count) throw new DomainError("INVALID_STATE_TRANSITION", "Approve the withdrawal before marking it paid");
      const wd = await tx.withdrawal.findUniqueOrThrow({ where: { id }, include: { wallet: true } });
      await this.ledger.post(tx, {
        type: "WITHDRAWAL_PAYOUT", idempotencyKey: `withdrawal-payout:${id}`, description: `Paid to ${wd.bankName} ••${wd.bankAccountLast4} (ref ${bankReference})`, createdByType: "ADMIN", createdById: adminId,
        entries: [
          { accountId: await this.wallets.accountId(wd.wallet.userId, "DRIVER", "WALLET_HELD", tx), direction: "DEBIT", amount: wd.amount },
          { accountId: await this.wallets.systemAccountId("BANK_PAYOUT_CLEARING", tx), direction: "CREDIT", amount: wd.amount },
        ],
      });
    });
  }
}
