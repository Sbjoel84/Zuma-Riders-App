/**
 * Paystack money flows against the fake provider: checkout top-ups, saved cards, card trips, declined
 * cards falling back to wallet or cash, late charge confirmations, webhooks (signature, duplicates),
 * driver commission payments, automatic payouts and reconciliation.
 */
import { Client } from "pg";
import { RedisService } from "../src/infra/redis.service";
import { PrismaService } from "../src/infra/prisma.service";
import { PaymentsService } from "../src/modules/payments/payments.service";
import { PLACES, TestApp } from "./helpers";

describe("payments", () => {
  const t = new TestApp();
  let pg: Client;
  let admin: string;

  beforeAll(async () => {
    await t.start();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    admin = (await t.login("+2348000000001", "ADMIN")).accessToken;
  });
  afterAll(async () => {
    await pg.end();
    await t.stop();
  });

  async function unbalanced() {
    const r = await pg.query(`SELECT count(*)::int AS n FROM (SELECT "transactionId" FROM "LedgerEntry" GROUP BY "transactionId" HAVING SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) <> 0) x`);
    return r.rows[0].n as number;
  }

  async function topup(token: string, amount: string, outcome: "success" | "success_decline_later" | "failed" = "success") {
    const api = t.api(token);
    const start = await api.post("/v1/payments/topups", { amount }, true).expect(201);
    expect(start.body.authorizationUrl).toContain("/v1/payments/fake-checkout/");
    const back = await t.payCheckout(start.body.reference, outcome).expect(303);
    expect(back.headers.location).toMatch(new RegExp(`^zuma(driver)?://payments/return\\?reference=${start.body.reference}$`));
    const v = await api.post(`/v1/payments/${start.body.reference}/verify`).expect(200);
    return v.body as { reference: string; status: string; amount: string };
  }

  async function trip(paxToken: string, drvToken: string, method: "CASH" | "WALLET" | "CARD", from = PLACES.maitama, to = PLACES.jabi) {
    const P = t.api(paxToken);
    const D = t.api(drvToken);
    const est = await P.post("/v1/ride-requests/estimate", { pickup: from, dropoff: to, categoryKey: "economy" }).expect(200);
    const fare = est.body.categories[0].suggestedFare as string;
    const req = await P.post("/v1/ride-requests", { pickup: from, dropoff: to, categoryKey: "economy", proposedFare: fare, paymentMethod: method }, true).expect(201);
    await D.post(`/v1/ride-requests/${req.body.id}/offers`, { acceptPassengerPrice: true }, true).expect(201);
    const offerId = (await P.get(`/v1/ride-requests/${req.body.id}`)).body.offers[0].id;
    const { rideId } = (await P.post(`/v1/ride-requests/${req.body.id}/offers/${offerId}/accept`, {}, true).expect(200)).body;
    const pin = (await P.get(`/v1/rides/${rideId}`)).body.tripPin;
    await D.post(`/v1/rides/${rideId}/arrived`).expect(200);
    await D.post(`/v1/rides/${rideId}/start`, { pin }).expect(200);
    const done = await D.post(`/v1/rides/${rideId}/complete`, to, true).expect(200);
    return { rideId: rideId as string, fare: BigInt(fare), done: done.body };
  }

  it("tops up a wallet through checkout, saves the card and is idempotent across verify + webhook", async () => {
    const pax = await t.login("08051110001", "PASSENGER");
    await t.api(pax.accessToken).post("/v1/me/profile", { firstName: "Ada", lastName: "Obi", termsVersion: "2026-11" }).expect(201);
    const P = t.api(pax.accessToken);

    await P.post("/v1/payments/topups", { amount: "5000" }, true).expect(422); // below ₦100
    const page = await t.http().get(`/v1/payments/fake-checkout/nope`).expect(404);
    expect(page.text).toContain("expired");

    const r = await topup(pax.accessToken, "500000");
    expect(r).toMatchObject({ status: "SUCCEEDED", amount: "500000" });
    expect((await P.get("/v1/wallet")).body.availableBalance).toBe("500000");
    const cards = (await P.get("/v1/payments/cards").expect(200)).body;
    expect(cards).toEqual([expect.objectContaining({ last4: "4081", brand: "visa", isDefault: true })]);
    // Card tokens are stored encrypted, never in plain text.
    const raw = await pg.query(`SELECT "authorizationCodeEnc" FROM "PaymentMethod" WHERE id=$1`, [cards[0].id]);
    expect(raw.rows[0].authorizationCodeEnc).toMatch(/^v1\./);

    // Paystack's webhook for the same charge, twice: no double credit.
    await t.paystackWebhook("charge.success", { reference: r.reference, id: 7001 }).expect(200);
    const dup = await t.paystackWebhook("charge.success", { reference: r.reference, id: 7001 }).expect(200);
    expect(dup.body.duplicate).toBe(true);
    await P.post(`/v1/payments/${r.reference}/verify`).expect(200);
    expect((await P.get("/v1/wallet")).body.availableBalance).toBe("500000");

    const fee = await pg.query(`SELECT count(*)::int n FROM "LedgerTransaction" WHERE "idempotencyKey" LIKE 'fee:%'`);
    expect(fee.rows[0].n).toBeGreaterThanOrEqual(1);
    expect((await t.pushes((await P.get("/v1/me")).body.id)).length).toBe(0); // no device registered yet → nothing pushed
    expect(await unbalanced()).toBe(0);
  });

  it("rejects webhooks with a bad signature and records them", async () => {
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "ZP-FORGED", id: 1 } });
    await t.http().post("/v1/webhooks/paystack").set("Content-Type", "application/json").set("x-paystack-signature", "deadbeef").send(raw).expect(401);
    const row = await pg.query(`SELECT status, "signatureValid" FROM "PaymentWebhook" WHERE "eventType"='charge.success' AND "signatureValid"=false`);
    expect(row.rows[0]).toMatchObject({ status: "SIGNATURE_INVALID", signatureValid: false });
  });

  it("does not credit a declined checkout", async () => {
    const pax = await t.passenger("08051110002", "Bisi");
    const r = await topup(pax.accessToken, "300000", "failed");
    expect(r.status).toBe("FAILED");
    expect((await t.api(pax.accessToken).get("/v1/wallet")).body.availableBalance).toBe("0");
    expect((await t.api(pax.accessToken).get("/v1/payments/cards")).body).toEqual([]);
  });

  it("charges the saved card at the end of a card trip and pays the driver into pending", async () => {
    const pax = await t.passenger("08051110003", "Chika");
    const drv = await t.onlineDriver("08061110003", "Musa", "ABJ 301 PY", PLACES.maitama, admin);
    await t.api(pax.accessToken).post("/v1/me/push-tokens", { token: "ExponentPushToken[pax-card-3]", platform: "ANDROID" }).expect(204);
    await t.api(drv.accessToken).post("/v1/me/push-tokens", { token: "ExponentPushToken[drv-card-3]", platform: "ANDROID" }).expect(204);

    // No card yet → booking with CARD is refused with a clear code
    const est = await t.api(pax.accessToken).post("/v1/ride-requests/estimate", { pickup: PLACES.maitama, dropoff: PLACES.jabi, categoryKey: "economy" }).expect(200);
    const noCard = await t.api(pax.accessToken).post("/v1/ride-requests", { pickup: PLACES.maitama, dropoff: PLACES.jabi, categoryKey: "economy", proposedFare: est.body.categories[0].suggestedFare, paymentMethod: "CARD" }, true).expect(422);
    expect(noCard.body.error.code).toBe("CARD_REQUIRED");

    await topup(pax.accessToken, "10000"); // ₦100 to save a card
    const { rideId, fare, done } = await trip(pax.accessToken, drv.accessToken, "CARD");
    expect(done.paymentMethod).toBe("CARD");
    const commission = (fare * 1500n) / 10000n;
    expect((await t.api(drv.accessToken).get("/v1/driver/wallet")).body.pendingBalance).toBe((fare - commission).toString());
    expect((await t.api(pax.accessToken).get("/v1/wallet")).body.availableBalance).toBe("10000"); // wallet untouched
    const view = (await t.api(pax.accessToken).get(`/v1/rides/${rideId}`)).body;
    expect(view).toMatchObject({ paymentMethod: "CARD", card: { last4: "4081" }, passengerPays: fare.toString() });

    const pay = await pg.query(`SELECT status, method, amount::text, "feeAmount"::text FROM "Payment" WHERE "rideId"=$1`, [rideId]);
    expect(pay.rows).toEqual([expect.objectContaining({ status: "SUCCEEDED", method: "CARD", amount: fare.toString() })]);
    const paxId = (await t.api(pax.accessToken).get("/v1/me")).body.id;
    expect((await t.pushes(paxId)).map((p) => p.title)).toEqual(expect.arrayContaining(["Your driver has arrived", "Trip complete"]));
    expect(await unbalanced()).toBe(0);
    await t.api(drv.accessToken).post("/v1/driver/availability/offline").expect(200);
  });

  it("falls back to cash when the card declines, and credits the wallet if Paystack later confirms the charge", async () => {
    const pax = await t.passenger("08051110004", "Dayo");
    const drv = await t.onlineDriver("08061110004", "Ibrahim", "ABJ 402 PY", PLACES.maitama, admin);
    await t.api(drv.accessToken).post("/v1/me/push-tokens", { token: "ExponentPushToken[drv-decline-4]", platform: "ANDROID" }).expect(204);
    await topup(pax.accessToken, "10000", "success_decline_later"); // saves a card that will decline; wallet only ₦100

    const { rideId, fare, done } = await trip(pax.accessToken, drv.accessToken, "CARD");
    expect(done.paymentMethod).toBe("CASH");
    const drvId = (await t.api(drv.accessToken).get("/v1/me")).body.id;
    expect((await t.pushes(drvId)).some((p) => p.title === "Collect cash")).toBe(true);
    const commission = (fare * 1500n) / 10000n;
    expect((await t.api(drv.accessToken).get("/v1/driver/wallet")).body.availableBalance).toBe((-commission).toString());

    // Paystack eventually reports the charge as successful → the passenger is not charged twice: it goes to their wallet.
    const failed = await pg.query(`SELECT reference, amount::text FROM "Payment" WHERE "rideId"=$1 AND method='CARD'`, [rideId]);
    expect(failed.rows[0]).toBeDefined();
    const ref = failed.rows[0].reference as string;
    await t.app.get(RedisService).client.set(`fakepay:txn:${ref}`, JSON.stringify({ amount: failed.rows[0].amount, status: "success", authorization: "AUTH_fake_late" }));
    await t.paystackWebhook("charge.success", { reference: ref }).expect(200);
    expect((await t.api(pax.accessToken).get("/v1/wallet")).body.availableBalance).toBe((10000n + fare).toString());
    expect(await unbalanced()).toBe(0);
    await t.api(drv.accessToken).post("/v1/driver/availability/offline").expect(200);
  });

  it("uses the wallet when the card declines and the wallet covers the fare", async () => {
    const pax = await t.passenger("08051110005", "Efe");
    const drv = await t.onlineDriver("08061110005", "Sani", "ABJ 503 PY", PLACES.maitama, admin);
    await topup(pax.accessToken, "2000000", "success_decline_later"); // ₦20,000 wallet, declining card
    const { fare, done } = await trip(pax.accessToken, drv.accessToken, "CARD");
    expect(done.paymentMethod).toBe("WALLET");
    expect((await t.api(pax.accessToken).get("/v1/wallet")).body.availableBalance).toBe((2000000n - fare).toString());
    await t.api(drv.accessToken).post("/v1/driver/availability/offline").expect(200);
  });

  it("lets drivers pay owed commission by card and sends automatic payouts, returning failed transfers", async () => {
    const drv = await t.onlineDriver("08061110006", "Grace", "ABJ 604 PY", PLACES.jabi, admin);
    const D = t.api(drv.accessToken);
    const r = await topup(drv.accessToken, "250000");
    expect(r.status).toBe("SUCCEEDED");
    expect((await D.get("/v1/driver/wallet")).body.availableBalance).toBe("250000");

    // Bank verification failures are explained
    const bad = await D.put("/v1/driver/bank-account", { bankCode: "058", accountNumber: "0001234567" }).expect(422);
    expect(bad.body.error.message).toMatch(/couldn't verify/);
    const unknownBank = await D.put("/v1/driver/bank-account", { bankCode: "999", accountNumber: "0123456789" }).expect(422);
    expect(unknownBank.body.error.message).toMatch(/Choose your bank/);
    const bank = await D.put("/v1/driver/bank-account", { bankCode: "057", accountNumber: "2233445566" }).expect(200);
    expect(bank.body).toMatchObject({ bankName: "Zenith Bank", last4: "5566", verified: true });

    const wd = await D.post("/v1/driver/withdrawals", { amount: "200000" }, true).expect(201);
    const A = t.api(admin);
    expect((await A.post(`/v1/admin/finance/withdrawals/${wd.body.id}/approve`).expect(200)).body.status).toBe("PROCESSING");
    await t.paystackWebhook("transfer.failed", { reference: `zuma-wd-${wd.body.id}`, reason: "Account closed" }).expect(200);
    expect((await D.get("/v1/driver/wallet")).body).toMatchObject({ availableBalance: "250000", heldBalance: "0" });
    const list = (await D.get("/v1/driver/withdrawals")).body;
    expect(list[0]).toMatchObject({ status: "FAILED" });
    expect((await A.get("/v1/admin/finance/webhooks").expect(200)).body.some((w: { eventType: string; status: string }) => w.eventType === "transfer.failed" && w.status === "PROCESSED")).toBe(true);
    expect(await unbalanced()).toBe(0);
    await D.post("/v1/driver/availability/offline").expect(200);
  });

  it("reconciles a checkout whose webhook never arrived", async () => {
    const pax = await t.passenger("08051110007", "Funmi");
    const P = t.api(pax.accessToken);
    const start = await P.post("/v1/payments/topups", { amount: "150000" }, true).expect(201);
    await t.payCheckout(start.body.reference).expect(303); // paid, but the app never came back and no webhook
    await pg.query(`UPDATE "Payment" SET "createdAt" = now() - interval '30 minutes' WHERE reference=$1`, [start.body.reference]);
    await t.app.get(PaymentsService).reconcile();
    expect((await P.get("/v1/wallet")).body.availableBalance).toBe("150000");
    const fin = await t.api(admin).get("/v1/admin/finance/payments?purpose=WALLET_TOPUP").expect(200);
    expect(fin.body.data.some((p: { reference: string; status: string }) => p.reference === start.body.reference && p.status === "SUCCEEDED")).toBe(true);
    const prisma = t.app.get(PrismaService).db;
    expect(await prisma.payment.count({ where: { reference: start.body.reference, status: "SUCCEEDED" } })).toBe(1);
  });
});
