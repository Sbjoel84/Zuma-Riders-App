import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Payment, Prisma, WalletOwnerType } from "@zuma/database";
import { Money } from "@zuma/contracts";
import { env } from "../../config/env";
import { DomainError, fail } from "../../common/errors";
import { decrypt, encrypt, sha256 } from "../../infra/crypto";
import { PaymentsGateway, type CardAuthorization, type ChargeResult } from "../../infra/payments.gateway";
import { isUniqueViolation, PrismaService, type Tx } from "../../infra/prisma.service";
import { LedgerService } from "../ledger/ledger.service";
import { WalletService } from "../ledger/wallet.service";
import { WithdrawalsService } from "../ledger/withdrawals.service";
import { NotificationsService } from "../notifications/notifications.service";
import { JobsService } from "../rides/jobs.service";
import { shortCode } from "../rides/codes";

const RETURN_URL = /^(zuma|zumadriver|exp(\+[a-z0-9-]+)?):\/\/|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//;

export interface PaymentView {
  reference: string;
  purpose: string;
  status: string;
  amount: string;
  failureReason: string | null;
  card: { brand: string | null; last4: string | null } | null;
  createdAt: string;
}

/**
 * Card money through Paystack, posted to the ledger:
 *  top-up       DR Paystack clearing / CR wallet available       (+ fee: DR provider fees / CR Paystack clearing)
 *  card trip    DR Paystack clearing / CR driver pending + commission revenue   (posted by SettlementService)
 * A payment is only ever marked successful after a server-side verify call (or a verified charge response);
 * webhooks and the app's "verify" call converge on the same idempotent `finalize`.
 */
@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly log = new Logger("Payments");

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentsGateway,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletService,
    private readonly withdrawals: WithdrawalsService,
    private readonly notify: NotificationsService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.gateway.onWebhook((raw, sig) => this.handleWebhook(raw, sig));
    this.jobs.register("payments-reconcile", () => this.reconcile());
  }

  private async emailFor(userId: string) {
    const u = await this.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
    return u.email ?? `${u.phoneE164.replace("+", "")}@${env().PAYMENT_EMAIL_DOMAIN}`;
  }

  private view(p: Payment & { paymentMethod?: { cardBrand: string | null; cardLast4: string | null } | null }): PaymentView {
    return {
      reference: p.reference, purpose: p.purpose, status: p.status, amount: p.amount.toString(), failureReason: p.failureReason,
      card: p.paymentMethod ? { brand: p.paymentMethod.cardBrand, last4: p.paymentMethod.cardLast4 } : null, createdAt: p.createdAt.toISOString(),
    };
  }

  // ---------------- top-ups ----------------

  /** Starts a Paystack checkout that credits the wallet of the app the user is signed into. Any reusable card is saved. */
  async startTopup(userId: string, ownerType: WalletOwnerType, amount: bigint, idempotencyKey: string, returnUrl?: string) {
    const e = env();
    if (amount < e.TOPUP_MIN_KOBO) fail("VALIDATION_FAILED", `The minimum top-up is ${Money.format(e.TOPUP_MIN_KOBO)}`);
    if (amount > e.TOPUP_MAX_KOBO) fail("VALIDATION_FAILED", `The maximum top-up is ${Money.format(e.TOPUP_MAX_KOBO)}`);
    const callbackUrl = returnUrl ?? (ownerType === "DRIVER" ? "zumadriver://payments/return" : "zuma://payments/return");
    if (!RETURN_URL.test(callbackUrl)) fail("VALIDATION_FAILED", "Unsupported return URL");

    const existing = await this.prisma.db.payment.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.userId !== userId) fail("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key belongs to another payment");
      const url = (existing.rawVerifyResponse as { authorizationUrl?: string } | null)?.authorizationUrl;
      return { reference: existing.reference, authorizationUrl: url ?? null, status: existing.status };
    }
    await this.wallets.ensureWallet(userId, ownerType);
    const purpose = ownerType === "DRIVER" ? "COMMISSION_SETTLEMENT" : "WALLET_TOPUP";
    const payment = await this.prisma.db.payment.create({
      data: { reference: shortCode("ZP", 12), idempotencyKey, userId, purpose, method: "CARD", provider: "PAYSTACK", amount, status: "INITIATED" },
    });
    try {
      const { authorizationUrl } = await this.gateway.initialize({
        email: await this.emailFor(userId), amount, reference: payment.reference, callbackUrl,
        metadata: { purpose, ownerType, userId, paymentId: payment.id },
      });
      await this.prisma.db.payment.update({ where: { id: payment.id }, data: { status: "PENDING", rawVerifyResponse: { authorizationUrl } } });
      return { reference: payment.reference, authorizationUrl, status: "PENDING" };
    } catch (err) {
      await this.prisma.db.payment.update({ where: { id: payment.id }, data: { status: "FAILED", failureReason: (err as Error).message.slice(0, 200) } });
      throw new DomainError("PAYMENT_FAILED", "We couldn't start the payment. Try again in a moment.");
    }
  }

  async get(userId: string, reference: string): Promise<PaymentView> {
    const p = await this.prisma.db.payment.findUnique({ where: { reference }, include: { paymentMethod: true } });
    if (!p || p.userId !== userId) fail("NOT_FOUND", "Payment not found");
    return this.view(p!);
  }

  /** Called by the app after returning from checkout. Safe to call repeatedly. */
  async verifyForUser(userId: string, reference: string): Promise<PaymentView> {
    const p = await this.prisma.db.payment.findUnique({ where: { reference } });
    if (!p || p.userId !== userId) fail("NOT_FOUND", "Payment not found");
    await this.finalize(reference);
    return this.get(userId, reference);
  }

  async history(userId: string) {
    const rows = await this.prisma.db.payment.findMany({ where: { userId, provider: "PAYSTACK" }, orderBy: { createdAt: "desc" }, take: 30, include: { paymentMethod: true } });
    return rows.map((p) => this.view(p));
  }

  /**
   * Converges a Paystack payment to its final state. Verifies with the provider first (outside any
   * transaction), then applies the result under a row lock so concurrent webhook + app verify calls
   * post the ledger exactly once.
   */
  async finalize(reference: string): Promise<{ matched: boolean; status?: string }> {
    const p = await this.prisma.db.payment.findUnique({ where: { reference } });
    if (!p) return { matched: false };
    if (p.status === "SUCCEEDED" || p.status === "REFUNDED") return { matched: true, status: p.status };
    if (p.purpose === "RIDE_FARE" && p.status !== "FAILED") return { matched: true, status: p.status }; // in-flight charge, owned by chargeForRide

    const result = await this.gateway.verify(reference);
    if (result.status === "pending") return { matched: true, status: p.status };

    const outcome = await this.prisma.db.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Payment" WHERE id = ${p.id} FOR UPDATE`;
      if (!locked || locked.status === "SUCCEEDED") return { status: locked?.status ?? "UNKNOWN", notify: null as null | "ok" | "late" | "failed" };

      if (result.status !== "success") {
        if (locked.status === "FAILED") return { status: "FAILED", notify: null };
        await tx.payment.update({ where: { id: p.id }, data: { status: result.status === "abandoned" ? "ABANDONED" : "FAILED", failureReason: result.message ?? "Payment was not completed", rawVerifyResponse: result.raw as Prisma.InputJsonValue } });
        return { status: "FAILED", notify: "failed" as const };
      }
      if (result.amount !== p.amount) {
        // Never credit an amount we did not ask for; finance resolves it from the suspense queue.
        await tx.payment.update({ where: { id: p.id }, data: { status: "FAILED", failureReason: `Amount mismatch: expected ${p.amount}, provider reported ${result.amount}`, rawVerifyResponse: result.raw as Prisma.InputJsonValue } });
        this.log.error(`Payment ${reference} amount mismatch (${p.amount} vs ${result.amount})`);
        return { status: "FAILED", notify: null };
      }

      const methodId = result.authorization ? await this.saveCard(tx, p.userId, result.authorization) : null;
      const late = p.purpose === "RIDE_FARE"; // charge we had given up on, now confirmed by Paystack
      await tx.payment.update({
        where: { id: p.id },
        data: {
          status: "SUCCEEDED", verifiedAt: new Date(), providerRef: result.providerRef, feeAmount: result.fees, paymentMethodId: methodId ?? p.paymentMethodId,
          rawVerifyResponse: result.raw as Prisma.InputJsonValue, failureReason: late ? "Charge confirmed after the trip was settled another way; credited to wallet" : null,
        },
      });
      const owner: WalletOwnerType = p.purpose === "COMMISSION_SETTLEMENT" ? "DRIVER" : "PASSENGER";
      await this.ledger.post(tx, {
        type: "WALLET_TOPUP", idempotencyKey: late ? `card-late:${p.id}` : `topup:${p.id}`,
        description: late ? `Card charge ${p.reference} credited to wallet` : owner === "DRIVER" ? "Paid towards Riders App commission" : "Wallet top-up by card",
        paymentId: p.id, createdByType: "SYSTEM",
        entries: [
          { accountId: await this.wallets.systemAccountId("PAYSTACK_CLEARING", tx), direction: "DEBIT", amount: p.amount },
          { accountId: await this.wallets.accountId(p.userId, owner, "WALLET_AVAILABLE", tx), direction: "CREDIT", amount: p.amount },
        ],
      });
      await this.postFee(tx, p.id, result.fees);
      return { status: "SUCCEEDED", notify: late ? ("late" as const) : ("ok" as const) };
    });

    if (outcome.notify === "ok") {
      this.notify.send(p.userId, { category: "PAYMENT", title: "Wallet topped up", body: `${Money.format(p.amount)} was added to your Riders App wallet.`, data: { type: "wallet" } });
    } else if (outcome.notify === "late") {
      this.notify.send(p.userId, { category: "PAYMENT", title: "Card payment received", body: `Your card payment of ${Money.format(p.amount)} went through after the trip, so we added it to your wallet.`, data: { type: "wallet" } });
    } else if (outcome.notify === "failed" && p.purpose !== "RIDE_FARE") {
      this.notify.send(p.userId, { category: "PAYMENT", title: "Payment not completed", body: "Your card payment didn't go through. You have not been charged.", data: { type: "wallet" } });
    }
    return { matched: true, status: outcome.status };
  }

  async postFee(tx: Tx, paymentId: string, fee: bigint) {
    if (fee <= 0n) return;
    await this.ledger.post(tx, {
      type: "ADJUSTMENT", idempotencyKey: `fee:${paymentId}`, description: "Paystack processing fee", paymentId, createdByType: "SYSTEM",
      entries: [
        { accountId: await this.wallets.systemAccountId("PROVIDER_FEES_EXPENSE", tx), direction: "DEBIT", amount: fee },
        { accountId: await this.wallets.systemAccountId("PAYSTACK_CLEARING", tx), direction: "CREDIT", amount: fee },
      ],
    });
  }

  // ---------------- cards ----------------

  private async saveCard(tx: Tx, userId: string, a: CardAuthorization): Promise<string | null> {
    if (!a.reusable) return null;
    const same = await tx.paymentMethod.findFirst({ where: { userId, type: "CARD", deletedAt: null, cardLast4: a.last4, cardBrand: a.brand, cardExpMonth: a.expMonth, cardExpYear: a.expYear } });
    if (same) {
      await tx.paymentMethod.update({ where: { id: same.id }, data: { authorizationCodeEnc: encrypt(a.code), isReusable: true } });
      return same.id;
    }
    const hasDefault = await tx.paymentMethod.count({ where: { userId, type: "CARD", deletedAt: null, isDefault: true } });
    const m = await tx.paymentMethod.create({
      data: {
        userId, type: "CARD", provider: "PAYSTACK", authorizationCodeEnc: encrypt(a.code), isReusable: true, isDefault: hasDefault === 0,
        cardBrand: a.brand, cardLast4: a.last4, cardExpMonth: a.expMonth, cardExpYear: a.expYear, bankName: a.bank,
      },
    });
    return m.id;
  }

  async cards(userId: string) {
    const rows = await this.prisma.db.paymentMethod.findMany({ where: { userId, type: "CARD", deletedAt: null, isReusable: true }, orderBy: { createdAt: "asc" } });
    return rows.map((c) => ({ id: c.id, brand: c.cardBrand, last4: c.cardLast4, expMonth: c.cardExpMonth, expYear: c.cardExpYear, bank: c.bankName, isDefault: c.isDefault }));
  }

  async setDefaultCard(userId: string, id: string) {
    const c = await this.prisma.db.paymentMethod.findFirst({ where: { id, userId, deletedAt: null, type: "CARD" } });
    if (!c) fail("NOT_FOUND", "Card not found");
    await this.prisma.db.$transaction([
      this.prisma.db.paymentMethod.updateMany({ where: { userId, type: "CARD" }, data: { isDefault: false } }),
      this.prisma.db.paymentMethod.update({ where: { id }, data: { isDefault: true } }),
    ]);
    return this.cards(userId);
  }

  async removeCard(userId: string, id: string) {
    const c = await this.prisma.db.paymentMethod.findFirst({ where: { id, userId, deletedAt: null, type: "CARD" } });
    if (!c) fail("NOT_FOUND", "Card not found");
    await this.prisma.db.paymentMethod.update({ where: { id }, data: { deletedAt: new Date(), isDefault: false, authorizationCodeEnc: null, isReusable: false } });
    if (c!.isDefault) {
      const next = await this.prisma.db.paymentMethod.findFirst({ where: { userId, type: "CARD", deletedAt: null, isReusable: true }, orderBy: { createdAt: "asc" } });
      if (next) await this.prisma.db.paymentMethod.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    return this.cards(userId);
  }

  async defaultCard(userId: string) {
    return this.prisma.db.paymentMethod.findFirst({ where: { userId, type: "CARD", deletedAt: null, isReusable: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  }

  // ---------------- card trips ----------------

  /**
   * Charges the passenger's saved card for a finished trip, before the completion transaction.
   * Idempotent per ride: a retry after a successful charge reuses it instead of charging twice.
   * Returns the successful payment, or null when the card can't be charged (settlement then falls back).
   */
  async chargeForRide(rideId: string, passengerUserId: string, amount: bigint, rideCode: string): Promise<{ payment: Payment | null; reason: string | null }> {
    const key = `ride-card:${rideId}`;
    const existing = await this.prisma.db.payment.findUnique({ where: { idempotencyKey: key } });
    if (existing?.status === "SUCCEEDED") return { payment: existing, reason: null };
    if (existing && existing.status !== "INITIATED") return { payment: null, reason: existing.failureReason ?? "Card was declined" };

    const card = await this.defaultCard(passengerUserId);
    if (!card?.authorizationCodeEnc) return { payment: null, reason: "No saved card" };

    let payment = existing;
    if (!payment) {
      try {
        payment = await this.prisma.db.payment.create({
          data: { reference: shortCode("ZT", 12), idempotencyKey: key, userId: passengerUserId, rideId, paymentMethodId: card.id, purpose: "RIDE_FARE", method: "CARD", provider: "PAYSTACK", amount, status: "INITIATED" },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        return this.chargeForRide(rideId, passengerUserId, amount, rideCode);
      }
    }

    let result: ChargeResult;
    try {
      result = await this.gateway.chargeAuthorization({ email: await this.emailFor(passengerUserId), amount, authorizationCode: decrypt(card.authorizationCodeEnc), reference: payment.reference });
    } catch (e) {
      result = { status: "failed", amount, fees: 0n, providerRef: null, message: (e as Error).message, authorization: null, raw: null };
    }
    if (result.status === "success" && result.amount === amount) {
      const updated = await this.prisma.db.payment.update({
        where: { id: payment.id },
        data: { status: "SUCCEEDED", verifiedAt: new Date(), providerRef: result.providerRef, feeAmount: result.fees, rawVerifyResponse: result.raw as Prisma.InputJsonValue },
      });
      return { payment: updated, reason: null };
    }
    const reason = result.status === "pending" ? "The bank didn't confirm the charge in time" : result.message ?? "Card was declined";
    await this.prisma.db.payment.update({ where: { id: payment.id }, data: { status: "FAILED", failureReason: reason, rawVerifyResponse: (result.raw ?? undefined) as Prisma.InputJsonValue | undefined } });
    this.log.warn(`Card charge for ${rideCode} failed: ${reason}`);
    return { payment: null, reason };
  }

  // ---------------- webhooks ----------------

  async handleWebhook(rawBody: string, signature: string | undefined): Promise<{ ok: boolean; duplicate?: boolean; status: number }> {
    const valid = this.gateway.verifySignature(rawBody, signature);
    let body: { event?: string; data?: Record<string, unknown> };
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { ok: false, status: 400 };
    }
    const event = String(body.event ?? "unknown");
    const data = body.data ?? {};
    const eventId = `${event}:${String(data.id ?? data.transfer_code ?? data.reference ?? sha256(rawBody))}`;
    let hook;
    try {
      hook = await this.prisma.db.paymentWebhook.create({
        data: { provider: "PAYSTACK", eventId: valid ? eventId : `invalid:${sha256(rawBody)}:${Date.now()}`, eventType: event, signatureValid: valid, payload: body as Prisma.InputJsonValue, status: valid ? "RECEIVED" : "SIGNATURE_INVALID" },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: true, duplicate: true, status: 200 };
      throw e;
    }
    if (!valid) return { ok: false, status: 401 };

    try {
      const reference = String(data.reference ?? "");
      let matched = false;
      let paymentId: string | null = null;
      if (event === "charge.success") {
        const r = await this.finalize(reference);
        matched = r.matched;
        paymentId = (await this.prisma.db.payment.findUnique({ where: { reference }, select: { id: true } }))?.id ?? null;
      } else if (event === "transfer.success" || event === "transfer.failed" || event === "transfer.reversed") {
        matched = await this.withdrawals.onTransferResult(reference, event === "transfer.success" ? "success" : "failed", String(data.reason ?? data.status ?? event));
      } else {
        matched = true; // events we don't act on are acknowledged
      }
      await this.prisma.db.paymentWebhook.update({ where: { id: hook.id }, data: { status: matched ? "PROCESSED" : "UNMATCHED", paymentId, processedAt: new Date(), attempts: { increment: 1 } } });
    } catch (e) {
      await this.prisma.db.paymentWebhook.update({ where: { id: hook.id }, data: { status: "FAILED", processingError: (e as Error).message.slice(0, 500), attempts: { increment: 1 } } });
      this.log.error(`Webhook ${event} failed: ${(e as Error).message}`);
      return { ok: false, status: 500 }; // Paystack retries
    }
    return { ok: true, status: 200 };
  }

  // ---------------- reconciliation ----------------

  /**
   * Every few minutes: re-verify checkouts that never got a webhook, and credit to the wallet any
   * successful card trip charge whose ride never settled (e.g. the trip was cancelled mid-completion).
   */
  async reconcile() {
    const staleBefore = new Date(Date.now() - 15 * 60_000);
    const stale = await this.prisma.db.payment.findMany({ where: { provider: "PAYSTACK", status: { in: ["PENDING", "INITIATED"] }, purpose: { not: "RIDE_FARE" }, createdAt: { lt: staleBefore } }, take: 50 });
    for (const p of stale) {
      const r = await this.finalize(p.reference).catch(() => null);
      if (r?.status === "PENDING" || r?.status === "INITIATED") {
        if (p.createdAt < new Date(Date.now() - 24 * 3600_000)) await this.prisma.db.payment.update({ where: { id: p.id }, data: { status: "ABANDONED" } });
      }
    }
    const orphans = await this.prisma.db.payment.findMany({ where: { purpose: "RIDE_FARE", provider: "PAYSTACK", status: "SUCCEEDED", createdAt: { lt: new Date(Date.now() - 10 * 60_000) } }, take: 100 });
    for (const p of orphans) {
      const posted = await this.prisma.db.ledgerTransaction.count({ where: { paymentId: p.id } });
      if (posted > 0) continue;
      await this.prisma.db.$transaction(async (tx) => {
        await this.ledger.post(tx, {
          type: "WALLET_TOPUP", idempotencyKey: `card-orphan:${p.id}`, description: `Card charge ${p.reference} credited to wallet`, paymentId: p.id, createdByType: "SYSTEM",
          entries: [
            { accountId: await this.wallets.systemAccountId("PAYSTACK_CLEARING", tx), direction: "DEBIT", amount: p.amount },
            { accountId: await this.wallets.accountId(p.userId, "PASSENGER", "WALLET_AVAILABLE", tx), direction: "CREDIT", amount: p.amount },
          ],
        });
        await this.postFee(tx, p.id, p.feeAmount);
      });
      this.notify.send(p.userId, { category: "PAYMENT", title: "Card payment credited", body: `${Money.format(p.amount)} from your card was added to your wallet.`, data: { type: "wallet" } });
    }
  }
}
