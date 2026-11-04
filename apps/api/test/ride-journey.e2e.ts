/**
 * The brief's 20-step end-to-end journey, against a real API, Postgres+PostGIS, Redis and Socket.IO.
 */
import { Client } from "pg";
import { PLACES, TestApp, waitFor } from "./helpers";

type Ev<T = Record<string, unknown>> = { eventId: string; data: T };

describe("full ride journey", () => {
  const t = new TestApp();
  let pg: Client;

  beforeAll(async () => {
    await t.start();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });
  afterAll(async () => {
    await pg.end();
    await t.stop();
  });

  it("passenger requests, driver counters, passenger accepts, trip runs, cash is settled and both rate", async () => {
    // 1–3. Accounts, admin verification
    const admin = await t.login("+2348000000001", "ADMIN");
    const pax = await t.passenger("08031110001", "Amaka");
    const drv = await t.onlineDriver("08061110002", "Ibrahim", "BWR 482 KD", PLACES.nearWuse2, admin.accessToken);

    // 4. Driver is online and connected
    const drvSock = await t.socket(drv.accessToken);
    const paxSock = await t.socket(pax.accessToken);
    const P = t.api(pax.accessToken);
    const D = t.api(drv.accessToken);

    // 5. Passenger estimates and requests
    const est = await P.post("/v1/ride-requests/estimate", { pickup: PLACES.wuse2, dropoff: PLACES.airport }).expect(200);
    const economy = est.body.categories.find((c: { categoryKey: string }) => c.categoryKey === "economy");
    expect(est.body.categories.map((c: { categoryKey: string }) => c.categoryKey)).not.toContain("motorcycle");
    const proposed = (BigInt(economy.suggestedFare) - 50000n).toString(); // ₦500 under suggested

    const newReq = waitFor<Ev<{ requestId: string; proposedFare: string; passenger: { firstName: string } }>>(drvSock, "ride_request.new");
    const created = await P.post("/v1/ride-requests", { pickup: PLACES.wuse2, dropoff: PLACES.airport, categoryKey: "economy", proposedFare: proposed, paymentMethod: "CASH" }, true).expect(201);
    expect(created.body.status).toBe("SEARCHING");

    // 6. Driver receives it (masked: first name only, pickup rounded)
    const incoming = await newReq;
    expect(incoming.data.requestId).toBe(created.body.id);
    expect(incoming.data.proposedFare).toBe(proposed);
    expect(incoming.data.passenger.firstName).toBe("Amaka");
    expect(JSON.stringify(incoming.data)).not.toContain("+234");

    // 7. Driver counter-offers +₦500
    const counter = (BigInt(proposed) + 50000n).toString();
    const offerEv = waitFor<Ev<{ offer: { id: string; amount: string; driver: Record<string, unknown> } }>>(paxSock, "offer.upserted");
    await D.post(`/v1/ride-requests/${created.body.id}/offers`, { amount: counter }, true).expect(201);
    const offer = (await offerEv).data.offer;
    expect(offer.amount).toBe(counter);
    expect(JSON.stringify(offer)).not.toContain("BWR"); // plate hidden before acceptance

    // Counter above the cap is refused
    const tooHigh = (BigInt(proposed) * 3n).toString();
    const bad = await D.post(`/v1/ride-requests/${created.body.id}/offers`, { amount: tooHigh }, true).expect(422);
    expect(bad.body.error.code).toBe("COUNTER_OFFER_OUT_OF_RANGE");

    // 8–9. Passenger accepts; driver is assigned
    const assigned = waitFor<Ev<{ rideId: string }>>(drvSock, "ride.assigned");
    const acc = await P.post(`/v1/ride-requests/${created.body.id}/offers/${offer.id}/accept`, {}, true).expect(200);
    const rideId = acc.body.rideId as string;
    expect((await assigned).data.rideId).toBe(rideId);

    const pv = await P.get(`/v1/rides/${rideId}`).expect(200);
    expect(pv.body.agreedFare).toBe(counter);
    expect(pv.body.vehicle.plateNumber).toBe("BWR 482 KD");
    expect(pv.body.tripPin).toMatch(/^\d{4}$/);
    const dv = await D.get(`/v1/rides/${rideId}`).expect(200);
    expect(dv.body.tripPin).toBeNull(); // the driver must get the PIN from the passenger

    // Agreed fare is locked in the database
    await expect(pg.query(`UPDATE "Ride" SET "agreedFare" = 1 WHERE id = $1`, [rideId])).rejects.toThrow(/locked/);

    // 10. Driver heads to pickup; passenger follows on the map
    await D.post(`/v1/rides/${rideId}/en-route`).expect(200);
    const loc = waitFor<Ev<{ lat: number }>>(paxSock, "ride.driver_location");
    const ack = await drvSock.emitWithAck("driver.location", { lat: 9.0767, lng: 7.4792, heading: 210, recordedAt: new Date().toISOString(), clientSeq: 1 });
    expect(ack).toEqual({ ok: true, rideId });
    expect((await loc).data.lat).toBeCloseTo(9.0767);

    // 11. Arrival
    await D.post(`/v1/rides/${rideId}/arrived`).expect(200);

    // 12–13. PIN check then start
    const wrongPin = pv.body.tripPin === "0000" ? "1111" : "0000";
    const w = await D.post(`/v1/rides/${rideId}/start`, { pin: wrongPin }).expect(422);
    expect(w.body.error.code).toBe("INVALID_TRIP_PIN");
    const started = await D.post(`/v1/rides/${rideId}/start`, { pin: pv.body.tripPin }).expect(200);
    expect(started.body.status).toBe("TRIP_STARTED");

    // Passenger cannot complete; driver can't skip states
    await P.post(`/v1/rides/${rideId}/complete`, PLACES.airport, true).expect(403);

    // 14–18. Completion, payment, commission, earnings
    const statusEv = waitFor<Ev<{ status: string }>>(paxSock, "ride.status", (e) => e.data.status === "TRIP_COMPLETED");
    const done = await D.post(`/v1/rides/${rideId}/complete`, PLACES.airport, true).expect(200);
    await statusEv;
    expect(done.body.finalFare).toBe(counter);
    const commission = (BigInt(counter) * 1500n) / 10000n;
    expect(done.body.commissionAmount).toBe(commission.toString());

    const wallet = await D.get("/v1/driver/wallet").expect(200);
    expect(wallet.body.availableBalance).toBe((-commission).toString()); // cash trip: driver owes commission

    const earnings = await D.get("/v1/driver/earnings?period=day").expect(200);
    expect(earnings.body).toMatchObject({ trips: 1, gross: counter, commission: commission.toString(), cashCollected: counter });

    // Ledger: every transaction balances
    const unbalanced = await pg.query(`SELECT "transactionId" FROM "LedgerEntry" GROUP BY "transactionId" HAVING SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) <> 0`);
    expect(unbalanced.rowCount).toBe(0);
    const revenue = await pg.query(`SELECT COALESCE(SUM(e.amount),0)::text AS s FROM "LedgerEntry" e JOIN "LedgerAccount" a ON a.id=e."accountId" JOIN "LedgerTransaction" t ON t.id=e."transactionId" WHERE a.purpose='PLATFORM_COMMISSION_REVENUE' AND e.direction='CREDIT' AND t."rideId"=$1`, [rideId]);
    expect(revenue.rows[0].s).toBe(commission.toString());

    // Completing twice is impossible and does not double-charge commission
    await D.post(`/v1/rides/${rideId}/complete`, PLACES.airport, true).expect(409);
    const commissions = await pg.query(`SELECT count(*)::int AS n FROM "Commission" WHERE "rideId" = $1`, [rideId]);
    expect(commissions.rows[0].n).toBe(1);

    // 19. Ratings both ways, once each
    await P.post(`/v1/rides/${rideId}/ratings`, { stars: 5, comment: "Smooth ride", tags: ["clean car"] }).expect(201);
    await P.post(`/v1/rides/${rideId}/ratings`, { stars: 4 }).expect(409);
    await D.post(`/v1/rides/${rideId}/ratings`, { stars: 5 }).expect(201);

    // Driver is free again
    const me = await D.get("/v1/driver/me").expect(200);
    expect(me.body.availability).toBe("ONLINE");

    // 20. Admin sees the trip, its money and the negotiation history
    const A = t.api(admin.accessToken);
    const rides = await A.get("/v1/admin/rides").expect(200);
    const r = rides.body.data.find((x: { id: string }) => x.id === rideId);
    expect(r).toMatchObject({ status: "TRIP_COMPLETED", proposedFare: proposed, agreedFare: counter, commission: commission.toString(), paymentMethod: "CASH" });
    const neg = await A.get(`/v1/admin/rides/${rideId}`).expect(200);
    expect(neg.body.negotiation.map((e: { action: string }) => e.action)).toEqual(["PASSENGER_PROPOSED", "DRIVER_COUNTER_OFFER", "PASSENGER_ACCEPTED_OFFER"]);
    expect(neg.body.statusHistory.map((h: { to: string }) => h.to)).toEqual(["DRIVER_SELECTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "TRIP_STARTED", "TRIP_COMPLETED"]);

    // Passengers and drivers cannot reach admin routes
    await P.get("/v1/admin/rides").expect(403);
  });
});
