/**
 * Promo codes (validation, pricing at acceptance, settlement funded by Riders App), referral rewards with
 * fraud checks, and authenticator-app two-factor sign-in for admins.
 */
import { Client } from "pg";
import { resetEnvCache } from "../src/config/env";
import { totp } from "../src/infra/crypto";
import { PrismaService } from "../src/infra/prisma.service";
import { PLACES, TestApp } from "./helpers";

describe("promos, referrals and admin 2FA", () => {
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
    process.env.ADMIN_2FA_REQUIRED = "false";
    resetEnvCache();
    await pg.end();
    await t.stop();
  });

  async function unbalanced() {
    const r = await pg.query(`SELECT count(*)::int AS n FROM (SELECT "transactionId" FROM "LedgerEntry" GROUP BY "transactionId" HAVING SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) <> 0) x`);
    return r.rows[0].n as number;
  }

  async function trip(paxToken: string, drvToken: string, opts: { method?: "CASH" | "WALLET"; promoCode?: string } = {}) {
    const P = t.api(paxToken);
    const D = t.api(drvToken);
    const est = await P.post("/v1/ride-requests/estimate", { pickup: PLACES.maitama, dropoff: PLACES.jabi, categoryKey: "economy" }).expect(200);
    const fare = est.body.categories[0].suggestedFare as string;
    const req = await P.post("/v1/ride-requests", { pickup: PLACES.maitama, dropoff: PLACES.jabi, categoryKey: "economy", proposedFare: fare, paymentMethod: opts.method ?? "CASH", promoCode: opts.promoCode }, true).expect(201);
    await D.post(`/v1/ride-requests/${req.body.id}/offers`, { acceptPassengerPrice: true }, true).expect(201);
    const offerId = (await P.get(`/v1/ride-requests/${req.body.id}`)).body.offers[0].id;
    const { rideId } = (await P.post(`/v1/ride-requests/${req.body.id}/offers/${offerId}/accept`, {}, true).expect(200)).body;
    const pin = (await P.get(`/v1/rides/${rideId}`)).body.tripPin;
    await D.post(`/v1/rides/${rideId}/arrived`).expect(200);
    await D.post(`/v1/rides/${rideId}/start`, { pin }).expect(200);
    const done = await D.post(`/v1/rides/${rideId}/complete`, PLACES.jabi, true).expect(200);
    return { rideId: rideId as string, fare: BigInt(fare), request: req.body, done: done.body };
  }

  const window = () => ({ startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 30 * 86400_000).toISOString() });

  it("applies a first-ride promo funded by Riders App: passenger pays less, driver earns on the full fare", async () => {
    const A = t.api(admin);
    await A.post("/v1/admin/promotions", { name: "Bad", code: "x", discountType: "PERCENTAGE", discountValue: 10, ...window() }).expect(422);
    await A.post("/v1/admin/promotions", { name: "Welcome to Riders App", code: "WELCOME50", discountType: "PERCENTAGE", discountValue: 50, maxDiscount: "100000", firstRideOnly: true, budget: "50000000", ...window() }).expect(201);
    await A.post("/v1/admin/promotions", { name: "Dup", code: "welcome50", discountType: "FIXED_AMOUNT", discountValue: 10000, ...window() }).expect(422);

    const pax = await t.passenger("08033330001", "Zainab");
    const drv = await t.onlineDriver("08063330001", "Danjuma", "ABJ 111 PR", PLACES.maitama, admin);
    const P = t.api(pax.accessToken);
    expect((await P.post("/v1/promos/check", { code: "NOPE123" }).expect(422)).body.error.code).toBe("PROMO_INVALID");
    const check = await P.post("/v1/promos/check", { code: "welcome50", categoryKey: "economy", fare: "300000" }).expect(200);
    expect(check.body).toMatchObject({ code: "WELCOME50", estimatedDiscount: "100000" });
    expect(check.body.description).toMatch(/50% off \(up to ₦1,000\) your first ride/);

    const { rideId, fare, request, done } = await trip(pax.accessToken, drv.accessToken, { promoCode: "WELCOME50" });
    expect(request.promo).toMatchObject({ code: "WELCOME50" });
    const discount = fare / 2n > 100000n ? 100000n : fare / 2n;
    const commission = (fare * 1500n) / 10000n;
    expect(done).toMatchObject({ discountAmount: discount.toString(), passengerPays: (fare - discount).toString(), finalFare: (fare - discount).toString(), paymentMethod: "CASH" });
    // Cash trip: driver collected fare − discount; Riders App owes them the discount and they owe the commission.
    expect((await t.api(drv.accessToken).get("/v1/driver/wallet")).body.availableBalance).toBe((discount - commission).toString());
    const earn = (await t.api(drv.accessToken).get("/v1/driver/earnings?period=day")).body;
    expect(earn.gross).toBe(fare.toString());

    const promos = (await A.get("/v1/admin/promotions").expect(200)).body;
    const w = promos.find((p: { codes: { code: string }[] }) => p.codes[0]?.code === "WELCOME50");
    expect(w).toMatchObject({ spent: discount.toString(), state: "LIVE" });
    expect(w.codes[0].usedCount).toBe(1);
    expect((await A.get(`/v1/admin/promotions/${w.id}/redemptions`).expect(200)).body[0]).toMatchObject({ amount: discount.toString(), ride: { id: rideId } });
    expect((await A.get(`/v1/admin/rides/${rideId}`).expect(200)).body).toMatchObject({ discount: discount.toString(), promoCode: "WELCOME50" });

    // Second ride: first-ride-only code is refused.
    const again = await P.post("/v1/promos/check", { code: "WELCOME50" }).expect(422);
    expect(again.body.error.message).toMatch(/first ride/);
    expect(await unbalanced()).toBe(0);
    await t.api(drv.accessToken).post("/v1/driver/availability/offline").expect(200);
  });

  it("applies a fixed promo to a wallet trip and stops working when paused", async () => {
    const A = t.api(admin);
    await A.post("/v1/admin/promotions", { name: "Weekend ₦500", code: "WEEKEND500", discountType: "FIXED_AMOUNT", discountValue: 50000, perUserLimit: 3, ...window() }).expect(201);
    const pax = await t.passenger("08033330002", "Kunle");
    const drv = await t.onlineDriver("08063330002", "Olu", "ABJ 222 PR", PLACES.maitama, admin);
    const paxId = (await t.api(pax.accessToken).get("/v1/me")).body.id;
    await A.post(`/v1/admin/finance/wallets/${paxId}/adjust`, { ownerType: "PASSENGER", direction: "CREDIT", amount: "1000000", reason: "Test wallet funding" }).expect(200);

    const { fare, done } = await trip(pax.accessToken, drv.accessToken, { method: "WALLET", promoCode: "WEEKEND500" });
    expect(done.paymentMethod).toBe("WALLET");
    expect((await t.api(pax.accessToken).get("/v1/wallet")).body.availableBalance).toBe((1000000n - (fare - 50000n)).toString());
    const commission = (fare * 1500n) / 10000n;
    expect((await t.api(drv.accessToken).get("/v1/driver/wallet")).body.pendingBalance).toBe((fare - commission).toString());

    const list = (await A.get("/v1/admin/promotions")).body;
    const id = list.find((p: { codes: { code: string }[] }) => p.codes[0]?.code === "WEEKEND500").id;
    await A.post(`/v1/admin/promotions/${id}/active`, { isActive: false }).expect(200);
    await t.api(pax.accessToken).post("/v1/promos/check", { code: "WEEKEND500" }).expect(422);
    const fin = (await A.get("/v1/admin/finance/summary?days=1").expect(200)).body;
    expect(BigInt(fin.promoSpend)).toBeGreaterThanOrEqual(50000n);
    expect(await unbalanced()).toBe(0);
    await t.api(drv.accessToken).post("/v1/driver/availability/offline").expect(200);
  });

  it("rewards both people after a referred rider's first trip, and rejects same-device referrals", async () => {
    const referrer = await t.passenger("08033330010", "Ifeoma");
    const R = t.api(referrer.accessToken);
    const code = (await R.get("/v1/me/referrals").expect(200)).body.code as string;
    expect(code).toMatch(/^ZU[A-Z0-9]{6}$/);
    await R.post("/v1/me/push-tokens", { token: "ExponentPushToken[ifeoma]", platform: "ANDROID" }).expect(204);

    const friend = await t.login("08033330011", "PASSENGER");
    await t.api(friend.accessToken).post("/v1/me/profile", { firstName: "Tobi", lastName: "Ade", termsVersion: "2026-11", referralCode: code.toLowerCase() }).expect(201);
    const drv = await t.onlineDriver("08063330010", "Femi", "ABJ 333 RF", PLACES.maitama, admin);
    await trip(friend.accessToken, drv.accessToken);

    const summary = (await R.get("/v1/me/referrals").expect(200)).body;
    expect(summary).toMatchObject({ earned: "50000", referrals: [expect.objectContaining({ name: "Tobi A.", status: "REWARDED" })] });
    expect((await R.get("/v1/wallet")).body.availableBalance).toBe("50000");
    expect((await t.api(friend.accessToken).get("/v1/wallet")).body.availableBalance).toBe("50000");
    const refId = (await R.get("/v1/me")).body.id;
    expect((await t.pushes(refId)).at(-1)).toMatchObject({ title: "You earned ₦500" });

    // Same phone signs up a "friend" → no reward.
    const sock = await t.login("08033330012", "PASSENGER");
    await t.api(sock.accessToken).post("/v1/me/profile", { firstName: "Puppet", lastName: "Acct", termsVersion: "2026-11", referralCode: code }).expect(201);
    const prisma = t.app.get(PrismaService).db;
    const sockUser = await prisma.user.findUniqueOrThrow({ where: { phoneE164: "+2348033330012" } });
    await prisma.device.create({ data: { userId: sockUser.id, installId: "test-08033330010-PASSENGER", platform: "ANDROID" } });
    await trip(sock.accessToken, drv.accessToken);
    expect((await R.get("/v1/wallet")).body.availableBalance).toBe("50000");
    const adminView = (await t.api(admin).get("/v1/admin/referrals").expect(200)).body;
    expect(adminView.data.find((r: { referee: string }) => r.referee === "Puppet Acct")).toMatchObject({ status: "REJECTED_FRAUD" });
    expect(adminView.totalPaid).toBe("100000");

    // Late referral codes: refused once you've taken a trip.
    const late = await t.api(friend.accessToken).post("/v1/me/referral", { code }).expect(422);
    expect(late.body.error.message).toMatch(/already used a referral code/);
    expect(await unbalanced()).toBe(0);
    await t.api(drv.accessToken).post("/v1/driver/availability/offline").expect(200);
  });

  it("signs admins in with an authenticator code after the SMS code, with recovery codes and enforcement", async () => {
    const A = t.api(admin);
    await A.post("/v1/admin/admins", { phone: "08000000077", firstName: "Sade", lastName: "Ops", roleKey: "super_admin" }).expect(201);
    const first = await t.login("08000000077", "ADMIN");
    const S = t.api(first.accessToken);
    expect((await S.get("/v1/admin/me/security").expect(200)).body).toMatchObject({ totpEnabled: false, required: false });

    const setup = (await S.post("/v1/admin/me/2fa/setup").expect(200)).body;
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Riders%20App%20Admin/);
    await S.post("/v1/admin/me/2fa/enable", { code: "000000" }).expect(401);
    const enabled = (await S.post("/v1/admin/me/2fa/enable", { code: totp(setup.secret) }).expect(200)).body;
    expect(enabled.recoveryCodes).toHaveLength(10);

    // SMS code alone no longer signs in.
    const step1 = async () => {
      const req = await t.http().post("/v1/auth/otp/request").send({ phone: "08000000077", appScope: "ADMIN" }).expect(200);
      const sms = t.smsTo("08000000077").at(-1)!;
      const res = await t.http().post("/v1/auth/otp/verify").send({ otpId: req.body.otpId, code: sms.body.match(/\d{6}/)![0], appScope: "ADMIN", device: { installId: "admin-web", platform: "WEB" } }).expect(200);
      return res.body as { mfaRequired?: boolean; mfaToken: string; accessToken?: string };
    };
    const s1 = await step1();
    expect(s1.mfaRequired).toBe(true);
    expect(s1.accessToken).toBeUndefined();
    expect((await t.http().post("/v1/auth/mfa/verify").send({ mfaToken: s1.mfaToken, code: "123456" }).expect(401)).body.error.code).toBe("MFA_INVALID");
    const code = totp(setup.secret);
    const ok = await t.http().post("/v1/auth/mfa/verify").send({ mfaToken: s1.mfaToken, code }).expect(200);
    expect(ok.body.accessToken).toBeTruthy();
    await t.api(ok.body.accessToken).get("/v1/admin/me").expect(200);
    // The ticket is single-use, and so is the code.
    await t.http().post("/v1/auth/mfa/verify").send({ mfaToken: s1.mfaToken, code }).expect(401);
    const s2 = await step1();
    expect((await t.http().post("/v1/auth/mfa/verify").send({ mfaToken: s2.mfaToken, code }).expect(401)).body.error.message).toMatch(/already used/);

    // Recovery code works once.
    const rc = enabled.recoveryCodes[0] as string;
    const viaRecovery = await t.http().post("/v1/auth/mfa/verify").send({ mfaToken: s2.mfaToken, code: rc.toLowerCase() }).expect(200);
    expect(viaRecovery.body.usedRecoveryCode).toBe(true);
    const s3 = await step1();
    await t.http().post("/v1/auth/mfa/verify").send({ mfaToken: s3.mfaToken, code: rc }).expect(401);
    expect((await t.api(viaRecovery.body.accessToken).get("/v1/admin/me/security")).body.recoveryCodesLeft).toBe(9);

    // Enforcement: with 2FA required, an admin without it can only reach the security setup.
    process.env.ADMIN_2FA_REQUIRED = "true";
    resetEnvCache();
    await A.post("/v1/admin/admins", { phone: "08000000078", firstName: "Bayo", lastName: "Fin", roleKey: "finance" }).expect(403); // super admin hasn't enrolled either
    const bayoBlocked = await A.get("/v1/admin/me").expect(403);
    expect(bayoBlocked.body.error.code).toBe("MFA_SETUP_REQUIRED");
    await A.get("/v1/admin/me/security").expect(200);
    await t.api(viaRecovery.body.accessToken).get("/v1/admin/me").expect(200); // Sade has 2FA
    await t.api(viaRecovery.body.accessToken).post("/v1/admin/me/2fa/disable", { code: totp(setup.secret, Date.now() + 30_000) }).expect(403);
    process.env.ADMIN_2FA_REQUIRED = "false";
    resetEnvCache();

    // Lost phone: another super admin resets it; the SMS code alone works again until re-enrolment.
    const sade = (await A.get("/v1/admin/admins").expect(200)).body.admins.find((a: { phone: string }) => a.phone === "+2348000000077");
    expect(sade.twoFactor).toBe(true);
    await A.post(`/v1/admin/admins/${sade.userId}/reset-2fa`, { reason: "Lost phone, verified in person" }).expect(200);
    await t.api(viaRecovery.body.accessToken).get("/v1/admin/me").expect(401); // signed out everywhere
    const s4 = await step1();
    expect(s4.accessToken).toBeTruthy();
  });
});
