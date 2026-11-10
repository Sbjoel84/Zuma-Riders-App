import { Injectable, Logger } from "@nestjs/common";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { env } from "../config/env";
import { RedisService } from "./redis.service";

export interface CardAuthorization {
  code: string;
  reusable: boolean;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  bank: string | null;
}

export interface ChargeResult {
  status: "success" | "failed" | "abandoned" | "pending";
  amount: bigint;
  fees: bigint;
  providerRef: string | null;
  message: string | null;
  authorization: CardAuthorization | null;
  raw: unknown;
}

export interface Bank {
  name: string;
  code: string;
}

export interface TransferResult {
  transferCode: string;
  status: "pending" | "success" | "failed";
}

/** Secret used to sign webhooks: the Paystack secret key, or a fixed dev value for the fake provider. */
export const FAKE_PAYSTACK_SECRET = "sk_test_fake_zuma_local_only";
export function webhookSecret(): string {
  return env().PAYSTACK_SECRET_KEY ?? FAKE_PAYSTACK_SECRET;
}
export function signWebhook(rawBody: string): string {
  return createHmac("sha512", webhookSecret()).update(rawBody).digest("hex");
}

/** Nigerian banks with their Paystack codes; the fake provider serves this list. */
const NG_BANKS: Bank[] = [
  ["Access Bank", "044"], ["Citibank Nigeria", "023"], ["Ecobank Nigeria", "050"], ["Fidelity Bank", "070"],
  ["First Bank of Nigeria", "011"], ["First City Monument Bank", "214"], ["Globus Bank", "00103"], ["Guaranty Trust Bank", "058"],
  ["Keystone Bank", "082"], ["Kuda Bank", "50211"], ["Moniepoint MFB", "50515"], ["OPay Digital Services", "999992"],
  ["PalmPay", "999991"], ["Polaris Bank", "076"], ["Providus Bank", "101"], ["Stanbic IBTC Bank", "221"],
  ["Standard Chartered Bank", "068"], ["Sterling Bank", "232"], ["Union Bank of Nigeria", "032"], ["United Bank For Africa", "033"],
  ["Unity Bank", "215"], ["Wema Bank", "035"], ["Zenith Bank", "057"],
].map(([name, code]) => ({ name: name!, code: code! }));

type WebhookSink = (rawBody: string, signature: string) => Promise<unknown>;

/**
 * Payment provider boundary. `paystack` talks to the Paystack API; `fake` (development and tests only,
 * refused in production by env validation) simulates checkout, card charges, bank lookups and transfers,
 * and can deliver signed webhooks through the same handler Paystack would call.
 */
@Injectable()
export class PaymentsGateway {
  private readonly log = new Logger("Payments");
  private sink: WebhookSink | null = null;

  constructor(private readonly redis: RedisService) {}

  get provider() {
    return env().PAYMENTS_PROVIDER;
  }

  /** PaymentsService registers its webhook handler so the fake provider can deliver events. */
  onWebhook(sink: WebhookSink) {
    this.sink = sink;
  }

  verifySignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = Buffer.from(createHmac("sha512", webhookSecret()).update(rawBody).digest("hex"));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  // ---------------- Paystack HTTP ----------------

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`https://api.paystack.co${path}`, {
      method,
      headers: { Authorization: `Bearer ${env().PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
    if (!res.ok || json.status === false) {
      this.log.warn(`Paystack ${method} ${path} → ${res.status}: ${json.message ?? "no message"}`);
      throw new PaymentProviderError(json.message ?? `Paystack error ${res.status}`, res.status);
    }
    return json.data as T;
  }

  private static toResult(d: PaystackTxn): ChargeResult {
    const a = d.authorization;
    const status = d.status === "success" ? "success" : d.status === "failed" || d.status === "reversed" ? "failed" : d.status === "abandoned" ? "abandoned" : "pending";
    return {
      status,
      amount: BigInt(d.amount ?? 0),
      fees: BigInt(d.fees ?? 0),
      providerRef: d.id != null ? String(d.id) : null,
      message: d.gateway_response ?? null,
      authorization: a?.authorization_code
        ? { code: a.authorization_code, reusable: Boolean(a.reusable), brand: a.card_type?.trim() ?? a.brand ?? null, last4: a.last4 ?? null, expMonth: a.exp_month ? Number(a.exp_month) : null, expYear: a.exp_year ? Number(a.exp_year) : null, bank: a.bank ?? null }
        : null,
      raw: d,
    };
  }

  // ---------------- operations ----------------

  async initialize(input: { email: string; amount: bigint; reference: string; callbackUrl: string; metadata?: Record<string, unknown> }): Promise<{ authorizationUrl: string }> {
    if (this.provider === "fake") {
      await this.redis.client.set(`fakepay:txn:${input.reference}`, JSON.stringify({ amount: input.amount.toString(), status: "pending", callbackUrl: input.callbackUrl }), "EX", 86400);
      return { authorizationUrl: `${env().PUBLIC_API_URL}/v1/payments/fake-checkout/${encodeURIComponent(input.reference)}` };
    }
    const d = await this.call<{ authorization_url: string }>("POST", "/transaction/initialize", {
      email: input.email, amount: Number(input.amount), reference: input.reference, callback_url: input.callbackUrl, currency: "NGN",
      channels: ["card", "bank", "ussd", "bank_transfer"], metadata: input.metadata,
    });
    return { authorizationUrl: d.authorization_url };
  }

  async verify(reference: string): Promise<ChargeResult> {
    if (this.provider === "fake") {
      const raw = await this.redis.client.get(`fakepay:txn:${reference}`);
      if (!raw) return { status: "failed", amount: 0n, fees: 0n, providerRef: null, message: "Unknown reference", authorization: null, raw: null };
      const t = JSON.parse(raw) as FakeTxn;
      return fakeResult(t, reference);
    }
    return PaymentsGateway.toResult(await this.call<PaystackTxn>("GET", `/transaction/verify/${encodeURIComponent(reference)}`));
  }

  async chargeAuthorization(input: { email: string; amount: bigint; authorizationCode: string; reference: string }): Promise<ChargeResult> {
    if (this.provider === "fake") {
      const declined = input.authorizationCode.includes("decline");
      const t: FakeTxn = { amount: input.amount.toString(), status: declined ? "failed" : "success", authorization: input.authorizationCode };
      await this.redis.client.set(`fakepay:txn:${input.reference}`, JSON.stringify(t), "EX", 86400);
      return fakeResult(t, input.reference);
    }
    try {
      return PaymentsGateway.toResult(await this.call<PaystackTxn>("POST", "/transaction/charge_authorization", {
        email: input.email, amount: Number(input.amount), authorization_code: input.authorizationCode, reference: input.reference, currency: "NGN",
      }));
    } catch (e) {
      if (e instanceof PaymentProviderError) return { status: "failed", amount: input.amount, fees: 0n, providerRef: null, message: e.message, authorization: null, raw: null };
      throw e;
    }
  }

  async banks(): Promise<Bank[]> {
    if (this.provider === "fake") return NG_BANKS;
    const cached = await this.redis.client.get("paystack:banks");
    if (cached) return JSON.parse(cached) as Bank[];
    const d = await this.call<Array<{ name: string; code: string; active: boolean }>>("GET", "/bank?country=nigeria&currency=NGN&perPage=200");
    const list = d.filter((b) => b.active).map((b) => ({ name: b.name, code: b.code })).sort((a, b) => a.name.localeCompare(b.name));
    await this.redis.client.set("paystack:banks", JSON.stringify(list), "EX", 86400);
    return list;
  }

  async resolveAccount(accountNumber: string, bankCode: string): Promise<{ accountName: string }> {
    if (this.provider === "fake") {
      if (accountNumber.startsWith("000")) throw new PaymentProviderError("Could not resolve account name. Check the account number and bank.", 422);
      return { accountName: `ZUMA TEST ACCOUNT ${accountNumber.slice(-4)}` };
    }
    const d = await this.call<{ account_name: string }>("GET", `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);
    return { accountName: d.account_name };
  }

  async createRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<string> {
    if (this.provider === "fake") return `RCP_fake_${randomBytes(6).toString("hex")}`;
    const d = await this.call<{ recipient_code: string }>("POST", "/transferrecipient", {
      type: "nuban", name: input.name, account_number: input.accountNumber, bank_code: input.bankCode, currency: "NGN",
    });
    return d.recipient_code;
  }

  async transfer(input: { amount: bigint; recipientCode: string; reference: string; reason: string }): Promise<TransferResult> {
    if (this.provider === "fake") {
      const code = `TRF_fake_${randomBytes(6).toString("hex")}`;
      if (env().FAKE_PAYMENTS_AUTO_WEBHOOK) {
        setTimeout(() => void this.fakeDeliver("transfer.success", { reference: input.reference, transfer_code: code, amount: Number(input.amount), status: "success" }), 1500);
      }
      return { transferCode: code, status: "pending" };
    }
    const d = await this.call<{ transfer_code: string; status: string }>("POST", "/transfer", {
      source: "balance", amount: Number(input.amount), recipient: input.recipientCode, reference: input.reference, reason: input.reason, currency: "NGN",
    });
    return { transferCode: d.transfer_code, status: d.status === "success" ? "success" : d.status === "failed" ? "failed" : "pending" };
  }

  // ---------------- fake checkout ----------------

  async fakeCheckoutState(reference: string): Promise<FakeTxn | null> {
    const raw = await this.redis.client.get(`fakepay:txn:${reference}`);
    return raw ? (JSON.parse(raw) as FakeTxn) : null;
  }

  /** Completes a fake checkout the way a customer would on Paystack's page. */
  async fakeComplete(reference: string, outcome: "success" | "success_decline_later" | "failed"): Promise<FakeTxn | null> {
    const t = await this.fakeCheckoutState(reference);
    if (!t || t.status !== "pending") return t;
    t.status = outcome === "failed" ? "failed" : "success";
    if (t.status === "success") t.authorization = `AUTH_fake_${outcome === "success_decline_later" ? "decline_" : ""}${randomBytes(5).toString("hex")}`;
    await this.redis.client.set(`fakepay:txn:${reference}`, JSON.stringify(t), "EX", 86400);
    if (t.status === "success" && env().FAKE_PAYMENTS_AUTO_WEBHOOK) {
      setTimeout(() => void this.fakeDeliver("charge.success", { reference, amount: Number(t.amount), status: "success" }), 300);
    }
    return t;
  }

  private async fakeDeliver(event: string, data: Record<string, unknown>) {
    if (!this.sink) return;
    const raw = JSON.stringify({ event, data: { id: Math.floor(Math.random() * 1e9), ...data } });
    try {
      await this.sink(raw, signWebhook(raw));
    } catch (e) {
      this.log.error(`Fake webhook ${event} failed: ${(e as Error).message}`);
    }
  }
}

export interface FakeTxn {
  amount: string;
  status: "pending" | "success" | "failed";
  callbackUrl?: string;
  authorization?: string;
}

function fakeResult(t: FakeTxn, reference: string): ChargeResult {
  const amount = BigInt(t.amount);
  const fees = t.status === "success" ? Money_fee(amount) : 0n;
  const declined = t.authorization?.includes("decline") ?? false;
  return {
    status: t.status === "success" ? "success" : t.status === "failed" ? "failed" : "pending",
    amount, fees, providerRef: `fake_${reference}`, message: t.status === "failed" ? "Declined" : null,
    authorization: t.authorization ? { code: t.authorization, reusable: true, brand: declined ? "mastercard" : "visa", last4: declined ? "1881" : "4081", expMonth: 12, expYear: 2030, bank: "TEST BANK" } : null,
    raw: { fake: true, ...t },
  };
}

/** Paystack local card pricing: 1.5% + ₦100 (₦100 waived under ₦2,500), capped at ₦2,000. */
function Money_fee(amount: bigint): bigint {
  let fee = (amount * 15n) / 1000n + (amount >= 250000n ? 10000n : 0n);
  if (fee > 200000n) fee = 200000n;
  return fee;
}

export class PaymentProviderError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

interface PaystackTxn {
  id?: number;
  status?: string;
  amount?: number;
  fees?: number | null;
  gateway_response?: string;
  authorization?: { authorization_code?: string; reusable?: boolean; card_type?: string; brand?: string; last4?: string; exp_month?: string; exp_year?: string; bank?: string };
}
