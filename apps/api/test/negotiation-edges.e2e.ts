/**
 * Race conditions and failure paths: concurrent accepts, one driver accepted by two passengers at once,
 * duplicate submits, fare limits, refresh-token reuse, expiry, wallet settlement and earnings release.
 */
import { randomUUID } from "crypto";
import { Client } from "pg";
import { MatchingService } from "../src/modules/rides/matching.service";
import { LedgerService } from "../src/modules/ledger/ledger.service";
import { WalletService } from "../src/modules/ledger/wallet.service";
import { PrismaService } from "../src/infra/prisma.service";
import { PLACES, sleep, TestApp, waitFor } from "./helpers";

describe("negotiation edge cases", () => {
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

  async function request(paxToken: string, from = PLACES.maitama, to = PLACES.jabi, method: "CASH" | "WALLET" = "CASH") {
    const P = t.api(paxToken);
    const est = await P.post("/v1/ride-requests/estimate", { pickup: from, dropoff: to, categoryKey: "economy" }).expect(200);
    const fare = est.body.categories[0].suggestedFare as string;
    const r = await P.post("/v1/ride-requests", { pickup: from, dropoff: to, categoryKey: "economy", proposedFare: fare, paymentMethod: method }, true).expect(201);
    return { id: r.body.id as string, fare };
  }

  it("lets exactly one of many concurrent accepts win", async () => {
    const pax = await t.passenger("08032220001", "Tunde");
    const d1 = await t.onlineDriver("08062220002", "Musa", "ABC 731 FG", PLACES.maitama, admin);
    const d2 = await t.onlineDriver("08062220003", "Chinedu", "KUJ 208 AB", PLACES.maitama, admin);
    const req = await request(pax.accessToken);

    const o1 = await t.api(d1.accessToken).post(`/v1/ride-requests/${req.id}/offers`, { acceptPassengerPrice: true }, true).expect(201);
    const o2 = await t.api(d2.accessToken).post(`/v1/ride-requests/${req.id}/offers`, { acceptPassengerPrice: true }, true).expect(201);
    const offerIds = (await t.api(pax.accessToken).get(`/v1/ride-requests/${req.id}`).expect(200)).body.offers.map((o: { id: string }) => o.id);
    expect(offerIds).toHaveLength(2);
    void o1; void o2;

    // 10 parallel accepts spread across both offers, each with its own idempotency key.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => t.api(pax.accessToken).post(`/v1/ride-requests/${req.id}/offers/${offerIds[i % 2]}/accept`, {}, randomUUID())),
    );
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    results.filter((r) => r.status !== 200).forEach((r) => expect(["REQUEST_CLOSED", "DRIVER_NO_LONGER_AVAILABLE"]).toContain(r.body.error.code));
    const rides = await pg.query(`SELECT count(*)::int AS n FROM "Ride" WHERE "rideRequestId" = $1`, [req.id]);
    expect(rides.rows[0].n).toBe(1);

    // Clean up: cancel the ride so drivers are free for later tests.
    await t.api(pax.accessToken).post(`/v1/rides/${ok[0]!.body.rideId}/cancel`, { reasonCode: "CHANGED_PLANS" }).expect(200);
  });

  it("never assigns one driver to two passengers who accept at the same moment", async () => {
    const a = await t.passenger("08033330001", "Hauwa");
    const b = await t.passenger("08033330002", "Zainab");
    const drv = await t.onlineDriver("08063330003", "Peter", "GWA 590 CD", PLACES.wuse2, admin);
    const ra = await request(a.accessToken, PLACES.wuse2, PLACES.jabi);
    const rb = await request(b.accessToken, PLACES.nearWuse2, PLACES.maitama);
    const D = t.api(drv.accessToken);
    await D.post(`/v1/ride-requests/${ra.id}/offers`, { acceptPassengerPrice: true }, true).expect(201);
    await D.post(`/v1/ride-requests/${rb.id}/offers`, { acceptPassengerPrice: true }, true).expect(201);
    const oa = (await t.api(a.accessToken).get(`/v1/ride-requests/${ra.id}`)).body.offers[0].id;
    const ob = (await t.api(b.accessToken).get(`/v1/ride-requests/${rb.id}`)).body.offers[0].id;

    const [x, y] = await Promise.all([
      t.api(a.accessToken).post(`/v1/ride-requests/${ra.id}/offers/${oa}/accept`, {}, true),
      t.api(b.accessToken).post(`/v1/ride-requests/${rb.id}/offers/${ob}/accept`, {}, true),
    ]);
    const statuses = [x.status, y.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    expect(loser.body.error.code).toBe("DRIVER_NO_LONGER_AVAILABLE");
    const active = await pg.query(`SELECT count(*)::int AS n FROM "Ride" WHERE "driverId" = $1 AND status IN ('DRIVER_SELECTED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','TRIP_STARTED')`, [drv.driverId]);
    expect(active.rows[0].n).toBe(1);

    const winner = x.status === 200 ? { tok: a.accessToken, ride: x.body.rideId } : { tok: b.accessToken, ride: y.body.rideId };
    await t.api(winner.tok).post(`/v1/rides/${winner.ride}/cancel`, { reasonCode: "CHANGED_PLANS" }).expect(200);
    const loserTok = x.status === 409 ? a.accessToken : b.accessToken;
    const loserReq = x.status === 409 ? ra.id : rb.id;
    await t.api(loserTok).post(`/v1/ride-requests/${loserReq}/cancel`, { reasonCode: "CHANGED_PLANS" }).expect(200);
  });

  it("returns the same request for a repeated submit with the same Idempotency-Key", async () => {
    const pax = await t.passenger("08034440001", "Femi");
    const P = t.api(pax.accessToken);
    const est = await P.post("/v1/ride-requests/estimate", { pickup: PLACES.jabi, dropoff: PLACES.maitama, categoryKey: "economy" }).expect(200);
    const body = { pickup: PLACES.jabi, dropoff: PLACES.maitama, categoryKey: "economy", proposedFare: est.body.categories[0].suggestedFare, paymentMethod: "CASH" };
    const key = randomUUID();
    const [r1, r2] = await Promise.all([P.post("/v1/ride-requests", body, key), P.post("/v1/ride-requests", body, key)]);
    expect([r1.status, r2.status].every((s) => s === 201)).toBe(true);
    expect(r1.body.id).toBe(r2.body.id);
    // A different key while one is open is refused.
    const again = await P.post("/v1/ride-requests", body, true).expect(409);
    expect(again.body.error.code).toBe("ACTIVE_REQUEST_EXISTS");
    await P.post(`/v1/ride-requests/${r1.body.id}/cancel`, { reasonCode: "CHANGED_PLANS" }).expect(200);
  });

  it("enforces fare limits, service area and disabled categories", async () => {
    const pax = await t.passenger("08035550001", "Ngozi");
    const P = t.api(pax.accessToken);
    const low = await P.post("/v1/ride-requests", { pickup: PLACES.wuse2, dropoff: PLACES.airport, categoryKey: "economy", proposedFare: "10000", paymentMethod: "CASH" }, true).expect(422);
    expect(low.body.error.code).toBe("FARE_BELOW_MINIMUM");
    const lagos = await P.post("/v1/ride-requests/estimate", { pickup: PLACES.lagos, dropoff: PLACES.wuse2 }).expect(422);
    expect(lagos.body.error.code).toBe("OUTSIDE_SERVICE_AREA");
    const moto = await P.post("/v1/ride-requests/estimate", { pickup: PLACES.wuse2, dropoff: PLACES.jabi, categoryKey: "motorcycle" }).expect(422);
    expect(moto.body.error.code).toBe("CATEGORY_UNAVAILABLE");
    const card = await P.post("/v1/ride-requests", { pickup: PLACES.wuse2, dropoff: PLACES.jabi, categoryKey: "economy", proposedFare: "500000", paymentMethod: "CARD" }, true).expect(422);
    expect(card.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("keeps unverified drivers offline and out of matching", async () => {
    const tok = (await t.login("08066660001", "DRIVER")).accessToken;
    const D = t.api(tok);
    await D.post("/v1/me/profile", { firstName: "Yusuf", lastName: "Driver", termsVersion: "2026-11" }).expect(201);
    await D.post("/v1/driver/onboarding", { licenceNumber: "ABJ99999ZZ01", licenceExpiresAt: "2029-01-01", addressLine: "Plot 4, Lugbe Estate" }).expect(201);
    const r = await D.post("/v1/driver/availability/online", PLACES.wuse2).expect(403);
    expect(r.body.error.code).toBe("DRIVER_NOT_VERIFIED");
  });

  it("detects refresh-token reuse and signs the whole family out", async () => {
    const pax = await t.passenger("08037770001", "Blessing");
    const first = await t.http().post("/v1/auth/refresh").send({ refreshToken: pax.refreshToken }).expect(200);
    // Old token used again → theft assumed → family revoked
    const reuse = await t.http().post("/v1/auth/refresh").send({ refreshToken: pax.refreshToken }).expect(401);
    expect(reuse.body.error.code).toBe("TOKEN_REUSED");
    await t.http().post("/v1/auth/refresh").send({ refreshToken: first.body.refreshToken }).expect(401);
    // The access token minted from the family is dead too
    await t.api(first.body.accessToken).get("/v1/me").expect(401);
  });

  it("expires requests with no accepted offer and tells drivers", async () => {
    const pax = await t.passenger("08038880001", "Ifeanyi");
    const drv = await t.onlineDriver("08068880002", "Aliyu", "BWR 337 EF", PLACES.jabi, admin);
    const drvSock = await t.socket(drv.accessToken);
    const paxSock = await t.socket(pax.accessToken);
    const arrived = waitFor<{ data: { requestId: string } }>(drvSock, "ride_request.new");
    const req = await request(pax.accessToken, PLACES.jabi, PLACES.maitama);
    await arrived;
    await pg.query(`UPDATE "RideRequest" SET "expiresAt" = now() - interval '1 second' WHERE id = $1`, [req.id]);
    const closed = waitFor<{ data: { reason: string } }>(drvSock, "ride_request.closed");
    const paxStatus = waitFor<{ data: { status: string } }>(paxSock, "ride_request.status");
    await t.app.get(MatchingService).expire(req.id);
    expect((await closed).data.reason).toBe("EXPIRED");
    expect((await paxStatus).data.status).toBe("EXPIRED");
    const late = await t.api(drv.accessToken).post(`/v1/ride-requests/${req.id}/offers`, { acceptPassengerPrice: true }, true).expect(409);
    expect(late.body.error.code).toBe("REQUEST_CLOSED");
    await t.api(drv.accessToken).post("/v1/driver/availability/offline").expect(200);
  });

  it("settles a wallet trip into the driver's pending balance and releases it after the hold", async () => {
    const pax = await t.passenger("08039990001", "Kelechi");
    const drv = await t.onlineDriver("08069990002", "Halima", "ABJ 671 LM", PLACES.maitama, admin);

    // Fund the passenger wallet through the ledger (top-ups via Paystack arrive in the payments phase).
    const prisma = t.app.get(PrismaService).db;
    const wallets = t.app.get(WalletService);
    const passengerUser = await prisma.user.findUniqueOrThrow({ where: { phoneE164: "+2348039990001" } });
    await prisma.$transaction(async (tx) => {
      await t.app.get(LedgerService).post(tx, {
        type: "ADJUSTMENT", idempotencyKey: `test-fund:${passengerUser.id}`, description: "Test funding", createdByType: "SYSTEM",
        entries: [
          { accountId: await wallets.systemAccountId("SUSPENSE", tx), direction: "DEBIT", amount: 2_000_000n },
          { accountId: await wallets.accountId(passengerUser.id, "PASSENGER", "WALLET_AVAILABLE", tx), direction: "CREDIT", amount: 2_000_000n },
        ],
      });
    });

    const req = await request(pax.accessToken, PLACES.maitama, PLACES.jabi, "WALLET");
    const D = t.api(drv.accessToken);
    await D.post(`/v1/ride-requests/${req.id}/offers`, { acceptPassengerPrice: true }, true).expect(201);
    const offerId = (await t.api(pax.accessToken).get(`/v1/ride-requests/${req.id}`)).body.offers[0].id;
    const { rideId } = (await t.api(pax.accessToken).post(`/v1/ride-requests/${req.id}/offers/${offerId}/accept`, {}, true).expect(200)).body;
    const pin = (await t.api(pax.accessToken).get(`/v1/rides/${rideId}`)).body.tripPin;
    await D.post(`/v1/rides/${rideId}/arrived`).expect(200);
    await D.post(`/v1/rides/${rideId}/start`, { pin }).expect(200);
    const done = await D.post(`/v1/rides/${rideId}/complete`, PLACES.jabi, true).expect(200);
    expect(done.body.paymentMethod).toBe("WALLET");

    const fare = BigInt(req.fare);
    const commission = (fare * 1500n) / 10000n;
    const paxWallet = await t.api(pax.accessToken).get("/v1/wallet").expect(200);
    expect(paxWallet.body.availableBalance).toBe((2_000_000n - fare).toString());
    let dw = await D.get("/v1/driver/wallet").expect(200);
    expect(dw.body.pendingBalance).toBe((fare - commission).toString());

    // EARNINGS_HOLD_S=1 in tests: the release job moves it to available.
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      dw = await D.get("/v1/driver/wallet").expect(200);
      if (dw.body.pendingBalance === "0") break;
    }
    expect(dw.body).toMatchObject({ pendingBalance: "0", availableBalance: (fare - commission).toString() });

    const txns = await D.get("/v1/driver/wallet/transactions").expect(200);
    expect(txns.body.data[0]).toMatchObject({ direction: "CREDIT", amount: (fare - commission).toString() });
  });
});

describe("sign-in rate limits", () => {
  const t = new TestApp();
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  it("refuses more than the per-phone limit of code requests", async () => {
    const limit = Number(process.env.OTP_LIMIT_PER_PHONE_10MIN);
    for (let i = 0; i < limit; i++) await t.http().post("/v1/auth/otp/request").send({ phone: "08079999999", appScope: "PASSENGER" }).expect(200);
    const r = await t.http().post("/v1/auth/otp/request").send({ phone: "08079999999", appScope: "PASSENGER" }).expect(429);
    expect(r.body.error.code).toBe("RATE_LIMITED");
  });
});
