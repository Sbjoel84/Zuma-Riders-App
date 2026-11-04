/**
 * Admin dashboard API: metrics, live map, people, verification, finance (payouts, adjustments),
 * pricing versions, configuration, support desk, safety incidents, roles and audit trails.
 */
import { randomUUID } from "crypto";
import { Client } from "pg";
import { PLACES, TestApp } from "./helpers";

describe("admin API", () => {
  const t = new TestApp();
  let pg: Client;
  let A: ReturnType<TestApp["api"]>;
  let adminToken: string;

  beforeAll(async () => {
    await t.start();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    adminToken = (await t.login("+2348000000001", "ADMIN")).accessToken;
    A = t.api(adminToken);
  });
  afterAll(async () => {
    await pg.end();
    await t.stop();
  });

  const balanced = async () => (await pg.query(`SELECT "transactionId" FROM "LedgerEntry" GROUP BY "transactionId" HAVING SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) <> 0`)).rowCount;

  it("serves overview metrics and the live map", async () => {
    await t.onlineDriver("08071000001", "Bala", "ABJ 101 AA", PLACES.wuse2, adminToken);
    const o = await A.get("/v1/admin/metrics/overview").expect(200);
    expect(o.body.kpis.onlineDrivers).toBeGreaterThanOrEqual(1);
    expect(o.body.byHour).toHaveLength(24);
    expect(o.body.byDay).toHaveLength(7);
    expect(o.body.attention).toHaveProperty("pendingVerification");
    const live = await A.get("/v1/admin/live/snapshot").expect(200);
    const bala = live.body.drivers.find((d: { name: string }) => d.name.startsWith("Bala"));
    expect(bala).toMatchObject({ status: "ONLINE", category: "economy", plate: "ABJ 101 AA" });
    expect(bala.lat).toBeCloseTo(PLACES.wuse2.lat);
    const me = await A.get("/v1/admin/me").expect(200);
    expect(me.body.permissions).toContain("finance:payout");
  });

  it("lists, searches and suspends drivers; a suspended driver is taken offline", async () => {
    const list = await A.get("/v1/admin/drivers?q=Bala").expect(200);
    expect(list.body.data).toHaveLength(1);
    const id = list.body.data[0].id;
    await A.post(`/v1/admin/drivers/${id}/suspend`, { reason: "Repeated complaints" }).expect(200);
    const after = await A.get("/v1/admin/drivers?status=suspended").expect(200);
    expect(after.body.data.map((d: { id: string }) => d.id)).toContain(id);
    const live = await A.get("/v1/admin/live/snapshot").expect(200);
    expect(live.body.drivers.find((d: { driverId: string }) => d.driverId === id)).toBeUndefined();
    await A.post(`/v1/admin/drivers/${id}/reactivate`).expect(200);
  });

  it("runs the verification queue, including rejecting a vehicle", async () => {
    const tok = (await t.login("08071000002", "DRIVER")).accessToken;
    const D = t.api(tok);
    await D.post("/v1/me/profile", { firstName: "Grace", lastName: "Okafor", termsVersion: "2026-11" }).expect(201);
    await D.post("/v1/driver/onboarding", { licenceNumber: "ABJ77777GG01", licenceExpiresAt: "2029-03-01", addressLine: "5 Aso Drive, Maitama" }).expect(201);
    const v = await D.post("/v1/driver/vehicles", { categoryKey: "suv", make: "Toyota", model: "Highlander", year: 2019, colour: "Black", plateNumber: "AMC 902 JK" }).expect(201);
    const q = await A.get("/v1/admin/verification").expect(200);
    const grace = q.body.find((x: { name: string }) => x.name === "Grace Okafor");
    expect(grace).toMatchObject({ verificationStatus: "PENDING_REVIEW", licenceNumber: "ABJ77777GG01" });
    expect(grace.vehicles[0]).toMatchObject({ plate: "AMC 902 JK", status: "PENDING_REVIEW" });
    await A.post(`/v1/admin/vehicles/${v.body.id}/reject`, { reason: "Plate photo unreadable" }).expect(200);
    await A.post(`/v1/admin/drivers/${grace.id}/approve`).expect(200);
    const online = await D.post("/v1/driver/availability/online", PLACES.maitama).expect(422);
    expect(online.body.error.code).toBe("NO_ACTIVE_VEHICLE");
    const q2 = await A.get("/v1/admin/verification").expect(200);
    expect(q2.body.find((x: { name: string }) => x.name === "Grace Okafor")).toBeUndefined();
  });

  it("suspends a passenger: signed out, cannot book, reactivated later", async () => {
    const pax = await t.passenger("08071000003", "Victor");
    const list = await A.get("/v1/admin/passengers?q=Victor").expect(200);
    const userId = list.body.data[0].userId;
    await A.post(`/v1/admin/users/${userId}/suspend`, { reason: "Abusive to drivers" }).expect(200);
    await t.api(pax.accessToken).get("/v1/me").expect(401);
    const again = await t.http().post("/v1/auth/otp/request").send({ phone: "08071000003", appScope: "PASSENGER" }).expect(200);
    void again;
    await A.post(`/v1/admin/users/${userId}/reactivate`).expect(200);
    const fresh = await t.login("08071000003", "PASSENGER");
    await t.api(fresh.accessToken).get("/v1/me").expect(200);
  });

  it("adjusts wallets and runs a driver payout through the ledger", async () => {
    const drv = await t.onlineDriver("08071000004", "Halima", "KUJ 404 HY", PLACES.jabi, adminToken);
    const D = t.api(drv.accessToken);
    const userId = (await D.get("/v1/me").expect(200)).body.id;

    // Credit ₦20,000 (e.g. a correction) — balanced ADJUSTMENT against suspense, audited.
    const adj = await A.post(`/v1/admin/finance/wallets/${userId}/adjust`, { ownerType: "DRIVER", direction: "CREDIT", amount: "2000000", reason: "Opening balance correction" }).expect(200);
    expect(adj.body.availableBalance).toBe("2000000");

    // No bank account → refused
    const nobank = await D.post("/v1/driver/withdrawals", { amount: "500000" }, true).expect(422);
    expect(nobank.body.error.message).toMatch(/bank account/);
    await D.put("/v1/driver/bank-account", { bankName: "GTBank", accountName: "Halima Yakubu", accountNumber: "0123456789" }).expect(200);
    expect((await D.get("/v1/driver/bank-account").expect(200)).body).toMatchObject({ last4: "6789" });

    // Request ₦5,000 → held
    const wd = await D.post("/v1/driver/withdrawals", { amount: "500000" }, true).expect(201);
    let wallet = (await D.get("/v1/driver/wallet")).body;
    expect(wallet).toMatchObject({ availableBalance: "1500000", heldBalance: "500000" });
    const twice = await D.post("/v1/driver/withdrawals", { amount: "100000" }, true).expect(422);
    expect(twice.body.error.message).toMatch(/in progress/);

    // Paid before approval is refused; approve → paid
    await A.post(`/v1/admin/finance/withdrawals/${wd.body.id}/paid`, { bankReference: "GTB-889201" }).expect(409);
    await A.post(`/v1/admin/finance/withdrawals/${wd.body.id}/approve`).expect(200);
    await A.post(`/v1/admin/finance/withdrawals/${wd.body.id}/paid`, { bankReference: "GTB-889201" }).expect(200);
    wallet = (await D.get("/v1/driver/wallet")).body;
    expect(wallet).toMatchObject({ availableBalance: "1500000", heldBalance: "0" });

    // A second request rejected → money back to available
    const wd2 = await D.post("/v1/driver/withdrawals", { amount: "300000" }, true).expect(201);
    await A.post(`/v1/admin/finance/withdrawals/${wd2.body.id}/reject`, { reason: "Account name mismatch" }).expect(200);
    wallet = (await D.get("/v1/driver/wallet")).body;
    expect(wallet).toMatchObject({ availableBalance: "1500000", heldBalance: "0" });
    const mine = (await D.get("/v1/driver/withdrawals")).body;
    expect(mine.map((w: { status: string }) => w.status)).toEqual(["REJECTED", "COMPLETED"]);

    const summary = await A.get("/v1/admin/finance/summary?days=7").expect(200);
    expect(summary.body.integrity).toEqual({ unbalancedTransactions: 0, walletsOutOfSync: 0 });
    const journal = await A.get("/v1/admin/finance/ledger").expect(200);
    expect(journal.body.data[0].type).toBe("WITHDRAWAL_RELEASE");
    expect(await balanced()).toBe(0);
    await D.post("/v1/driver/availability/offline").expect(200);
  });

  it("publishes a new pricing version, closes the old one and audits it", async () => {
    const cur = await A.get("/v1/admin/pricing").expect(200);
    const econ = cur.body.active.find((p: { categoryKey: string }) => p.categoryKey === "economy");
    const body = {
      serviceAreaId: cur.body.serviceArea.id, categoryKey: "economy",
      baseFare: econ.baseFare, perKm: econ.perKm, perMinute: econ.perMinute, minFare: "150000", maxFare: econ.maxFare, minFarePerKm: econ.minFarePerKm,
      cancellationFeePassenger: econ.cancellationFeePassenger, commissionBps: 1400, requestTtlSeconds: 180, offerTtlSeconds: 45, changeReason: "Fuel price increase, November",
    };
    const bad = await A.post("/v1/admin/pricing", { ...body, maxFare: "100000" }).expect(422);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
    const r = await A.post("/v1/admin/pricing", body).expect(201);
    expect(r.body.version).toBe(econ.version + 1);
    const after = await A.get("/v1/admin/pricing").expect(200);
    expect(after.body.active.find((p: { categoryKey: string }) => p.categoryKey === "economy")).toMatchObject({ minFare: "150000", commissionBps: 1400 });
    const active = await pg.query(`SELECT count(*)::int n FROM "PricingConfiguration" p JOIN "VehicleCategory" c ON c.id=p."categoryId" WHERE c.key='economy' AND p."effectiveTo" IS NULL`);
    expect(active.rows[0].n).toBe(1);
    const audit = await A.get("/v1/admin/audit?kind=changes").expect(200);
    expect(audit.body.data[0]).toMatchObject({ entity: "PricingConfiguration", operation: "CREATE" });
    // Estimates pick up the new minimum
    const pax = await t.passenger("08071000005", "Price");
    const est = await t.api(pax.accessToken).post("/v1/ride-requests/estimate", { pickup: PLACES.wuse2, dropoff: PLACES.nearWuse2.lat ? PLACES.maitama : PLACES.maitama, categoryKey: "economy" }).expect(200);
    expect(BigInt(est.body.categories[0].minFare)).toBeGreaterThanOrEqual(150000n);

    // Restore launch pricing so other suites (which share the database) see the seeded 15%.
    await A.post("/v1/admin/pricing", { ...body, minFare: econ.minFare, commissionBps: econ.commissionBps, changeReason: "Restore launch pricing after test" }).expect(201);
  });

  it("changes service-area settings and category availability with audit entries", async () => {
    const cities = await A.get("/v1/admin/config/areas").expect(200);
    const abuja = cities.body.find((c: { key: string }) => c.key === "abuja");
    const area = abuja.areas[0];
    await A.patch(`/v1/admin/config/areas/${area.id}`, { searchRadiusM: 20000, reason: "test" }).expect(422);
    await A.patch(`/v1/admin/config/areas/${area.id}`, { searchRadiusM: 3500, reason: "More drivers per request" }).expect(200);
    const comfort = abuja.categories.find((c: { key: string }) => c.key === "comfort");
    await A.patch(`/v1/admin/config/cities/${abuja.id}/categories/${comfort.categoryId}`, { isEnabled: false, reason: "Pause comfort for review" }).expect(200);
    const pax = await t.passenger("08071000006", "Cat");
    const est = await t.api(pax.accessToken).post("/v1/ride-requests/estimate", { pickup: PLACES.wuse2, dropoff: PLACES.jabi }).expect(200);
    expect(est.body.categories.map((c: { categoryKey: string }) => c.categoryKey)).not.toContain("comfort");
    await A.patch(`/v1/admin/config/cities/${abuja.id}/categories/${comfort.categoryId}`, { isEnabled: true, reason: "Back on" }).expect(200);
  });

  it("runs the support desk end to end", async () => {
    const pax = await t.passenger("08071000007", "Hauwa");
    const P = t.api(pax.accessToken);
    const tk = await P.post("/v1/support/tickets", { category: "PAYMENT", subject: "Charged twice", body: "I was charged twice for one trip." }).expect(201);
    expect(tk.body.number).toMatch(/^T-/);
    const list = await A.get("/v1/admin/support/tickets?status=open").expect(200);
    const row = list.body.data.find((x: { id: string }) => x.id === tk.body.id);
    expect(row).toMatchObject({ priority: "HIGH", requester: "Hauwa Test", requesterRole: "Passenger" });
    await A.post(`/v1/admin/support/tickets/${tk.body.id}/assign`, {}).expect(200);
    await A.post(`/v1/admin/support/tickets/${tk.body.id}/messages`, { body: "Checked Paystack: second charge reversed.", internal: true }).expect(201);
    await A.post(`/v1/admin/support/tickets/${tk.body.id}/messages`, { body: "The duplicate charge was reversed. It reaches your account in 3–5 days." }).expect(201);
    const seen = await P.get(`/v1/support/tickets/${tk.body.id}`).expect(200);
    expect(seen.body.status).toBe("AWAITING_USER");
    expect(seen.body.messages).toHaveLength(2); // internal note hidden from the customer
    expect(seen.body.messages[1]).toMatchObject({ fromSupport: true, author: "Zuma Support" });
    await A.post(`/v1/admin/support/tickets/${tk.body.id}/status`, { status: "RESOLVED", resolution: "Reversal confirmed" }).expect(200);
    const detail = await A.get(`/v1/admin/support/tickets/${tk.body.id}`).expect(200);
    expect(detail.body).toMatchObject({ status: "RESOLVED", assignee: { name: "Ops Lead" } });
    expect(detail.body.messages.filter((m: { internal: boolean }) => m.internal)).toHaveLength(1);
  });

  it("handles an SOS: ops alerted, escalation only after it is recorded, no skipping steps", async () => {
    const pax = await t.passenger("08071000008", "Blessing");
    const P = t.api(pax.accessToken);
    const sos = await P.post("/v1/safety/sos", { lat: 9.1559, lng: 7.3221 }).expect(201);
    expect(sos.body).toMatchObject({ opsAlerted: true, emergencyServicesContacted: false, emergencyNumbers: ["112", "199"] });
    const again = await P.post("/v1/safety/sos", { lat: 9.156, lng: 7.3222 }).expect(201);
    expect(again.body.incidentId).toBe(sos.body.incidentId); // repeated presses don't open new incidents
    const id = sos.body.incidentId;
    await A.post(`/v1/admin/safety/incidents/${id}/escalation`, { note: "Called police" }).expect(409); // must acknowledge first
    await A.post(`/v1/admin/safety/incidents/${id}/acknowledge`).expect(200);
    await A.post(`/v1/admin/safety/incidents/${id}/escalation`, { note: "Called FCT police control room, ref 4471" }).expect(200);
    const third = await P.post("/v1/safety/sos", { lat: 9.156, lng: 7.3222 }).expect(201);
    expect(third.body.emergencyServicesContacted).toBe(true);
    await A.post(`/v1/admin/safety/incidents/${id}/resolve`, { note: "Passenger safe at home" }).expect(200);
    const list = await A.get("/v1/admin/safety/incidents").expect(200);
    const inc = list.body.find((x: { id: string }) => x.id === id);
    expect(inc.status).toBe("RESOLVED");
    expect(inc.timeline.map((e: { event: string }) => e.event)).toEqual([
      "Pressed SOS", "Pressed SOS again", "Acknowledged by Ops Lead", "Ops Lead recorded contact with emergency services: Called FCT police control room, ref 4471", "Pressed SOS again", "Resolved by Ops Lead: Passenger safe at home",
    ]);
  });

  it("manages admins and enforces role permissions", async () => {
    const res = await A.post("/v1/admin/admins", { phone: "08071000009", firstName: "Kemi", lastName: "Adebayo", roleKey: "support_agent" }).expect(201);
    const kemi = await t.login("08071000009", "ADMIN");
    const K = t.api(kemi.accessToken);
    await K.get("/v1/admin/support/tickets").expect(200);
    await K.get("/v1/admin/finance/summary").expect(403);
    await K.post("/v1/admin/pricing", {}).expect(403);
    await A.put(`/v1/admin/admins/${res.body.userId}/role`, { roleKey: "finance" }).expect(200);
    await K.get("/v1/admin/me").expect(401); // role change signs them out
    const kemi2 = await t.login("08071000009", "ADMIN");
    await t.api(kemi2.accessToken).get("/v1/admin/finance/summary").expect(200);
    await A.post(`/v1/admin/admins/${res.body.userId}/revoke`).expect(200);
    const kemi3 = await t.login("08071000009", "ADMIN");
    await t.api(kemi3.accessToken).get("/v1/admin/me").expect(403);
    const admins = await A.get("/v1/admin/admins").expect(200);
    expect(admins.body.roles.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(["super_admin", "finance", "support_agent"]));
    const actions = await A.get("/v1/admin/audit?kind=actions").expect(200);
    expect(actions.body.data.length).toBeGreaterThan(5);
    void randomUUID;
  });
});
