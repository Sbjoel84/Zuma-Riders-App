import { Injectable, Logger } from "@nestjs/common";
import { Money } from "@zuma/contracts";
import { env } from "../../config/env";
import { DomainError, fail } from "../../common/errors";
import { PaymentProviderError, PaymentsGateway } from "../../infra/payments.gateway";
import { PrismaService } from "../../infra/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { LedgerService } from "./ledger.service";
import { WalletService } from "./wallet.service";

export const MIN_WITHDRAWAL = 100_000n; // ₦1,000

/**
 * Driver payouts.
 *   request  → DR available, CR held
 *   reject / transfer failed → DR held, CR available
 *   Paystack transfer succeeded → DR held, CR Paystack clearing (money left our Paystack balance)
 *   manual payout marked paid   → DR held, CR bank-payout clearing
 * Drivers whose bank account was verified with Paystack get automatic transfers once finance approves
 * (or immediately, up to PAYOUT_AUTO_APPROVE_MAX_KOBO). Older accounts without a recipient stay manual.
 */
@Injectable()
export class WithdrawalsService {
  private readonly log = new Logger("Payouts");

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletService,
    private readonly gateway: PaymentsGateway,
    private readonly notify: NotificationsService,
  ) {}

  /** Paystack transfer references: lowercase, 16–50 chars. */
  static transferRef(id: string) {
    return `zuma-wd-${id.toLowerCase()}`;
  }

  /** Verifies the account with the bank (name enquiry) and registers it as a Paystack transfer recipient. */
  async setBankAccount(userId: string, bankCode: string, accountNumber: string) {
    const driver = await this.prisma.db.driver.findUnique({ where: { userId } });
    if (!driver) fail("DRIVER_NOT_VERIFIED", "Finish driver registration first");
    const bank = (await this.gateway.banks()).find((b) => b.code === bankCode);
    if (!bank) fail("VALIDATION_FAILED", "Choose your bank from the list");
    let accountName: string;
    let recipientCode: string;
    try {
      ({ accountName } = await this.gateway.resolveAccount(accountNumber, bankCode));
      recipientCode = await this.gateway.createRecipient({ name: accountName, accountNumber, bankCode });
    } catch (e) {
      if (e instanceof PaymentProviderError) fail("VALIDATION_FAILED", e.status < 500 ? "We couldn't verify that account. Check the number and bank." : "Bank verification is unavailable. Try again shortly.");
      throw e;
    }
    await this.prisma.db.driver.update({
      where: { id: driver!.id },
      data: { bankName: bank!.name, bankCode, bankAccountName: accountName!, bankAccountLast4: accountNumber.slice(-4), payoutRecipientCode: recipientCode! },
    });
    return { bankName: bank!.name, bankCode, accountName: accountName!, last4: accountNumber.slice(-4), verified: true };
  }

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
          recipientCode: driver!.payoutRecipientCode ?? "MANUAL", provider: driver!.payoutRecipientCode ? "PAYSTACK" : "NONE", status: "REQUESTED",
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
    }).then(async (wd) => {
      const limit = env().PAYOUT_AUTO_APPROVE_MAX_KOBO;
      if (wd.provider === "PAYSTACK" && limit > 0n && wd.amount <= limit && wd.status === "REQUESTED") {
        await this.approve(wd.id, null).catch((e) => this.log.warn(`Auto-payout ${wd.id} not sent: ${(e as Error).message}`));
        return this.prisma.db.withdrawal.findUniqueOrThrow({ where: { id: wd.id } });
      }
      return wd;
    });
  }

  async list(userId: string) {
    const w = await this.wallets.ensureWallet(userId, "DRIVER");
    const rows = await this.prisma.db.withdrawal.findMany({ where: { walletId: w.id }, orderBy: { createdAt: "desc" }, take: 30 });
    return rows.map((r) => ({ id: r.id, amount: r.amount.toString(), status: r.status, bank: `${r.bankName} ••${r.bankAccountLast4}`, rejectionReason: r.rejectionReason, createdAt: r.createdAt.toISOString(), completedAt: r.completedAt?.toISOString() ?? null }));
  }

  /**
   * Approves a withdrawal. For Paystack recipients this also sends the transfer; the result arrives by
   * webhook (transfer.success / transfer.failed). If Paystack refuses the transfer outright, the
   * withdrawal goes back to APPROVED so finance can retry or pay manually.
   */
  async approve(id: string, adminId: string | null): Promise<{ status: string; message?: string }> {
    const c = await this.prisma.db.withdrawal.updateMany({ where: { id, status: "REQUESTED" }, data: { status: "APPROVED", approvedById: adminId, approvedAt: new Date() } });
    if (!c.count) {
      const wd = await this.prisma.db.withdrawal.findUnique({ where: { id } });
      if (wd?.status !== "APPROVED" || wd.provider !== "PAYSTACK") fail("INVALID_STATE_TRANSITION", "Only requested withdrawals can be approved");
    }
    const wd = await this.prisma.db.withdrawal.findUniqueOrThrow({ where: { id } });
    if (wd.provider !== "PAYSTACK" || wd.recipientCode === "MANUAL") return { status: "APPROVED" };
    return this.send(wd.id);
  }

  /** Sends (or re-sends) the Paystack transfer for an approved withdrawal. */
  async send(id: string): Promise<{ status: string; message?: string }> {
    const claimed = await this.prisma.db.withdrawal.updateMany({ where: { id, status: "APPROVED", provider: "PAYSTACK" }, data: { status: "PROCESSING" } });
    if (!claimed.count) fail("INVALID_STATE_TRANSITION", "This withdrawal is not waiting to be sent");
    const wd = await this.prisma.db.withdrawal.findUniqueOrThrow({ where: { id } });
    try {
      const t = await this.gateway.transfer({ amount: wd.amount, recipientCode: wd.recipientCode, reference: WithdrawalsService.transferRef(wd.id), reason: "Zuma driver earnings" });
      await this.prisma.db.withdrawal.update({ where: { id }, data: { providerRef: t.transferCode } });
      if (t.status === "success") await this.onTransferResult(WithdrawalsService.transferRef(wd.id), "success", "immediate");
      if (t.status === "failed") await this.onTransferResult(WithdrawalsService.transferRef(wd.id), "failed", "Transfer failed");
      return { status: t.status === "success" ? "COMPLETED" : t.status === "failed" ? "FAILED" : "PROCESSING" };
    } catch (e) {
      await this.prisma.db.withdrawal.update({ where: { id }, data: { status: "APPROVED" } });
      const message = e instanceof PaymentProviderError ? e.message : "Paystack could not be reached";
      this.log.warn(`Transfer for withdrawal ${id} not sent: ${message}`);
      return { status: "APPROVED", message: `Transfer not sent: ${message}. Try again or pay manually.` };
    }
  }

  /** Webhook outcome for a transfer we sent. Returns false when the reference isn't ours. */
  async onTransferResult(reference: string, result: "success" | "failed", reason: string): Promise<boolean> {
    if (!reference.startsWith("zuma-wd-")) return false;
    // Withdrawal ids are lowercase cuids, so the reference maps straight back to the row.
    const candidate = await this.prisma.db.withdrawal.findUnique({ where: { id: reference.slice("zuma-wd-".length) }, select: { id: true, provider: true } });
    if (!candidate || candidate.provider !== "PAYSTACK") return false;
    const wdId = candidate.id;
    const outcome = await this.prisma.db.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Withdrawal" WHERE id = ${wdId} FOR UPDATE`;
      if (!row || row.status === "COMPLETED" || row.status === "FAILED") return null;
      const wd = await tx.withdrawal.findUniqueOrThrow({ where: { id: wdId }, include: { wallet: true } });
      const held = await this.wallets.accountId(wd.wallet.userId, "DRIVER", "WALLET_HELD", tx);
      if (result === "success") {
        await tx.withdrawal.update({ where: { id: wdId }, data: { status: "COMPLETED", completedAt: new Date() } });
        await this.ledger.post(tx, {
          type: "WITHDRAWAL_PAYOUT", idempotencyKey: `withdrawal-payout:${wdId}`, description: `Paid to ${wd.bankName} ••${wd.bankAccountLast4}`, createdByType: "SYSTEM",
          entries: [
            { accountId: held, direction: "DEBIT", amount: wd.amount },
            { accountId: await this.wallets.systemAccountId("PAYSTACK_CLEARING", tx), direction: "CREDIT", amount: wd.amount },
          ],
        });
      } else {
        await tx.withdrawal.update({ where: { id: wdId }, data: { status: "FAILED", rejectionReason: `Transfer failed: ${reason}`.slice(0, 200) } });
        await this.ledger.post(tx, {
          type: "WITHDRAWAL_RELEASE", idempotencyKey: `withdrawal-release:${wdId}`, description: "Bank transfer failed, money returned to your balance", createdByType: "SYSTEM",
          entries: [
            { accountId: held, direction: "DEBIT", amount: wd.amount },
            { accountId: await this.wallets.accountId(wd.wallet.userId, "DRIVER", "WALLET_AVAILABLE", tx), direction: "CREDIT", amount: wd.amount },
          ],
        });
      }
      return { userId: wd.wallet.userId, amount: wd.amount, bank: `${wd.bankName} ••${wd.bankAccountLast4}` };
    });
    if (outcome) {
      this.notify.send(outcome.userId, result === "success"
        ? { category: "PAYMENT", title: "Payout sent", body: `${Money.format(outcome.amount)} is on its way to ${outcome.bank}.`, data: { type: "wallet" } }
        : { category: "PAYMENT", title: "Payout failed", body: `We couldn't pay ${Money.format(outcome.amount)} to ${outcome.bank}. The money is back in your balance.`, data: { type: "wallet" } });
    }
    return true;
  }

  async reject(id: string, adminId: string, reason: string) {
    const r = await this.prisma.db.$transaction(async (tx) => {
      const c = await tx.withdrawal.updateMany({ where: { id, status: { in: ["REQUESTED", "APPROVED"] } }, data: { status: "REJECTED", rejectionReason: reason, approvedById: adminId } });
      // APPROVED Paystack withdrawals only sit in APPROVED after a refused transfer, so rejecting them is safe.
      if (!c.count) throw new DomainError("INVALID_STATE_TRANSITION", "This withdrawal can no longer be rejected");
      const wd = await tx.withdrawal.findUniqueOrThrow({ where: { id }, include: { wallet: true } });
      await this.ledger.post(tx, {
        type: "WITHDRAWAL_RELEASE", idempotencyKey: `withdrawal-release:${id}`, description: `Withdrawal rejected: ${reason}`, createdByType: "ADMIN", createdById: adminId,
        entries: [
          { accountId: await this.wallets.accountId(wd.wallet.userId, "DRIVER", "WALLET_HELD", tx), direction: "DEBIT", amount: wd.amount },
          { accountId: await this.wallets.accountId(wd.wallet.userId, "DRIVER", "WALLET_AVAILABLE", tx), direction: "CREDIT", amount: wd.amount },
        ],
      });
      return wd;
    });
    this.notify.send(r.wallet.userId, { category: "PAYMENT", title: "Withdrawal not approved", body: `Your ${Money.format(r.amount)} withdrawal was declined: ${reason}. The money is back in your balance.`, data: { type: "wallet" } });
  }

  async markPaid(id: string, adminId: string, bankReference: string) {
    const r = await this.prisma.db.$transaction(async (tx) => {
      const c = await tx.withdrawal.updateMany({ where: { id, status: "APPROVED" }, data: { status: "COMPLETED", providerRef: bankReference, completedAt: new Date(), provider: "NONE" } });
      if (!c.count) throw new DomainError("INVALID_STATE_TRANSITION", "Approve the withdrawal before marking it paid");
      const wd = await tx.withdrawal.findUniqueOrThrow({ where: { id }, include: { wallet: true } });
      await this.ledger.post(tx, {
        type: "WITHDRAWAL_PAYOUT", idempotencyKey: `withdrawal-payout:${id}`, description: `Paid to ${wd.bankName} ••${wd.bankAccountLast4} (ref ${bankReference})`, createdByType: "ADMIN", createdById: adminId,
        entries: [
          { accountId: await this.wallets.accountId(wd.wallet.userId, "DRIVER", "WALLET_HELD", tx), direction: "DEBIT", amount: wd.amount },
          { accountId: await this.wallets.systemAccountId("BANK_PAYOUT_CLEARING", tx), direction: "CREDIT", amount: wd.amount },
        ],
      });
      return wd;
    });
    this.notify.send(r.wallet.userId, { category: "PAYMENT", title: "Payout sent", body: `${Money.format(r.amount)} was paid to ${r.bankName} ••${r.bankAccountLast4}.`, data: { type: "wallet" } });
  }
}
