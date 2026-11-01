import { Injectable } from "@nestjs/common";
import type { WalletView } from "@zuma/contracts";
import type { LedgerAccountPurpose, WalletOwnerType } from "@zuma/database";
import { env } from "../../config/env";
import { PrismaService, type Tx } from "../../infra/prisma.service";

const BUCKETS = ["WALLET_AVAILABLE", "WALLET_PENDING", "WALLET_HELD"] as const;

@Injectable()
export class WalletService {
  private systemIds = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  /** Creates the wallet and its three ledger accounts on first use. Safe to call repeatedly. */
  async ensureWallet(userId: string, ownerType: WalletOwnerType, tx?: Tx) {
    const db = tx ?? this.prisma.db;
    const existing = await db.wallet.findUnique({ where: { userId_ownerType: { userId, ownerType } }, include: { accounts: true } });
    if (existing) return existing;
    try {
      const wallet = await db.wallet.create({
        data: { userId, ownerType, negativeLimit: ownerType === "DRIVER" ? env().DRIVER_NEGATIVE_LIMIT_KOBO : 0n },
      });
      for (const purpose of BUCKETS) {
        await db.ledgerAccount.create({
          data: { code: `WAL:${wallet.id}:${purpose.replace("WALLET_", "")}`, type: "LIABILITY", purpose, walletId: wallet.id },
        });
      }
      return db.wallet.findUniqueOrThrow({ where: { id: wallet.id }, include: { accounts: true } });
    } catch (e) {
      // Concurrent creation: the other request won.
      const again = await db.wallet.findUnique({ where: { userId_ownerType: { userId, ownerType } }, include: { accounts: true } });
      if (again) return again;
      throw e;
    }
  }

  async accountId(userId: string, ownerType: WalletOwnerType, purpose: (typeof BUCKETS)[number], tx?: Tx): Promise<string> {
    const w = await this.ensureWallet(userId, ownerType, tx);
    const acct = w.accounts.find((a) => a.purpose === purpose);
    if (!acct) throw new Error(`Wallet ${w.id} missing ${purpose}`);
    return acct.id;
  }

  async systemAccountId(purpose: LedgerAccountPurpose, tx?: Tx): Promise<string> {
    const cached = this.systemIds.get(purpose);
    if (cached) return cached;
    const db = tx ?? this.prisma.db;
    const acct = await db.ledgerAccount.findUnique({ where: { code: `SYS:${purpose}:NGN` } });
    if (!acct) throw new Error(`System ledger account ${purpose} missing — run the seed`);
    this.systemIds.set(purpose, acct.id);
    return acct.id;
  }

  async view(userId: string, ownerType: WalletOwnerType): Promise<WalletView> {
    const w = await this.ensureWallet(userId, ownerType);
    return {
      ownerType,
      availableBalance: w.availableBalance.toString(),
      pendingBalance: w.pendingBalance.toString(),
      heldBalance: w.heldBalance.toString(),
      negativeLimit: w.negativeLimit.toString(),
    };
  }

  async transactions(userId: string, ownerType: WalletOwnerType, cursor?: string, limit = 20) {
    const w = await this.ensureWallet(userId, ownerType);
    const rows = await this.prisma.db.walletTransaction.findMany({
      where: { walletId: w.id },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      data: page.map((t) => ({
        id: t.id, type: t.type, direction: t.direction, amount: t.amount.toString(), balanceAfter: t.balanceAfter.toString(),
        status: t.status, description: t.description, rideId: t.rideId, createdAt: t.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }
}
