import { Injectable } from "@nestjs/common";
import type { ActorType, LedgerTxnType } from "@zuma/database";
import { type Tx } from "../../infra/prisma.service";

export interface Posting {
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: bigint;
}

export interface PostInput {
  type: LedgerTxnType;
  /** Deterministic key, e.g. `commission:{rideId}`. Posting the same key twice is a no-op. */
  idempotencyKey: string;
  description: string;
  entries: Posting[];
  rideId?: string;
  paymentId?: string;
  createdByType: ActorType;
  createdById?: string;
}

/**
 * The only writer of LedgerTransaction / LedgerEntry. Must run inside the caller's transaction so the
 * journal, the wallet balance caches and the business change commit together.
 * The database also enforces balance (deferred trigger) and immutability (triggers).
 */
@Injectable()
export class LedgerService {
  async post(tx: Tx, input: PostInput): Promise<{ id: string; replayed: boolean }> {
    const existing = await tx.ledgerTransaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return { id: existing.id, replayed: true };

    const entries = input.entries.filter((e) => e.amount !== 0n);
    if (entries.some((e) => e.amount < 0n)) throw new Error("Ledger amounts must be positive");
    const debit = entries.filter((e) => e.direction === "DEBIT").reduce((s, e) => s + e.amount, 0n);
    const credit = entries.filter((e) => e.direction === "CREDIT").reduce((s, e) => s + e.amount, 0n);
    if (debit !== credit || debit === 0n) throw new Error(`Unbalanced ledger transaction ${input.idempotencyKey}: ${debit} vs ${credit}`);

    const txn = await tx.ledgerTransaction.create({
      data: {
        type: input.type, idempotencyKey: input.idempotencyKey, description: input.description,
        rideId: input.rideId, paymentId: input.paymentId, createdByType: input.createdByType, createdById: input.createdById,
        entries: { create: entries.map((e) => ({ accountId: e.accountId, direction: e.direction, amount: e.amount })) },
      },
    });

    // Update cached wallet balances. Wallet accounts are liabilities: credit raises the balance, debit lowers it.
    const accounts = await tx.ledgerAccount.findMany({ where: { id: { in: entries.map((e) => e.accountId) } } });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const perWallet = new Map<string, { available: bigint; pending: bigint; held: bigint }>();
    for (const e of entries) {
      const acct = byId.get(e.accountId);
      if (!acct?.walletId) continue;
      const d = e.direction === "CREDIT" ? e.amount : -e.amount;
      const cur = perWallet.get(acct.walletId) ?? { available: 0n, pending: 0n, held: 0n };
      if (acct.purpose === "WALLET_AVAILABLE") cur.available += d;
      if (acct.purpose === "WALLET_PENDING") cur.pending += d;
      if (acct.purpose === "WALLET_HELD") cur.held += d;
      perWallet.set(acct.walletId, cur);
    }
    for (const [walletId, d] of perWallet) {
      const w = await tx.wallet.update({
        where: { id: walletId },
        data: {
          availableBalance: { increment: d.available },
          pendingBalance: { increment: d.pending },
          heldBalance: { increment: d.held },
          version: { increment: 1 },
        },
      });
      const net = d.available + d.pending;
      if (net !== 0n) {
        await tx.walletTransaction.create({
          data: {
            walletId, ledgerTransactionId: txn.id, type: input.type,
            direction: net > 0n ? "CREDIT" : "DEBIT", amount: net > 0n ? net : -net,
            balanceAfter: w.availableBalance, description: input.description, rideId: input.rideId,
          },
        });
      }
    }
    return { id: txn.id, replayed: false };
  }
}
