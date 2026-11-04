/**
 * Fills a LOCAL development database with realistic activity by driving the real API in-process:
 * drivers register and are approved, passengers book and negotiate, trips run to completion,
 * payouts are requested, tickets and an SOS are raised. Every row is created through the same
 * endpoints the apps use, so the dashboard shows what production would show.
 *
 *   pnpm --filter @zuma/api demo-data                 # once
 *   pnpm --filter @zuma/api demo-data --keepalive 30  # then keep demo drivers online for 30 minutes
 *   pnpm --filter @zuma/api demo-data --online-only 30  # only bring the demo drivers back online (no new activity)
 *
 * Refuses to run with NODE_ENV=production or a non-local DATABASE_URL.
 */
import "dotenv/config";
process.env.SMS_PROVIDER = "console";
process.env.OTP_LIMIT_PER_IP_HOUR = "100000";
process.env.OTP_LIMIT_PER_PHONE_10MIN = "1000";

import { normalizeNigerianPhone } from "@zuma/contracts";
import { randomUUID } from "crypto";
import { createApp } from "../src/app.factory";
import { SmsService } from "../src/infra/sms.service";

const DB = process.env.DATABASE_URL ?? "";
if (process.env.NODE_ENV === "production" || !/@(localhost|127\.0\.0\.1)[:/]/.test(DB)) {
  console.error("demo-data only runs against a local development database.");
  process.exit(1);
}

const P = {
  wuse2: { lat: 9.0765, lng: 7.479, address: "Wuse 2, Aminu Kano Crescent, Abuja" },
  banex: { lat: 9.0772, lng: 7.4801, address: "Banex Plaza, Wuse 2, Abuja" },
  airport: { lat: 9.0068, lng: 7.2632, address: "Nnamdi Azikiwe International Airport, Abuja" },
  jabi: { lat: 9.0703, lng: 7.4247, address: "Jabi Lake Mall, Jabi, Abuja" },
  maitama: { lat: 9.0882, lng: 7.4934, address: "Maitama District, Abuja" },
  garki: { lat: 9.0398, lng: 7.4876, address: "Garki Area 11, Abuja" },
  asokoro: { lat: 9.0435, lng: 7.5238, address: "Asokoro District, Abuja" },
  gwarinpa: { lat: 9.1099, lng: 7.4042, address: "1st Avenue, Gwarinpa, Abuja" },
  kubwa: { lat: 9.1559, lng: 7.3221, address: "Kubwa, Abuja" },
  lugbe: { lat: 8.9823, lng: 7.3776, address: "Lugbe, Abuja" },
  cbd: { lat: 9.0579, lng: 7.4951, address: "Central Business District, Abuja" },
  wusemarket: { lat: 9.0628, lng: 7.4666, address: "Wuse Market, Zone 5, Abuja" },
  utako: { lat: 9.0661, lng: 7.4431, address: "Utako Market, Abuja" },
  lifecamp: { lat: 9.0809, lng: 7.4029, address: "Life Camp, Abuja" },
};
type Place = (typeof P)[keyof typeof P];
const near = (p: Place, d = 0.002) => ({ lat: p.lat + d, lng: p.lng + d });

async function main() {
  const keepIdx = process.argv.indexOf("--keepalive");
  const onlineIdx = process.argv.indexOf("--online-only");
  const onlineOnly = onlineIdx > -1;
  const keepMinutes = onlineOnly ? Number(process.argv[onlineIdx + 1] ?? 20) : keepIdx > -1 ? Number(process.argv[keepIdx + 1] ?? 20) : 0;

  const { app, close } = await createApp();
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  const sms = app.get(SmsService);

  const call = async <T = any>(token: string | null, method: string, path: string, body?: unknown, idem = false): Promise<T> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (idem) headers["Idempotency-Key"] = randomUUID();
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json?.error ?? json)}`);
    return json as T;
  };
  const as = (t: string) => ({
    get: <T = any>(p: string) => call<T>(t, "GET", p),
    post: <T = any>(p: string, b?: unknown, idem = false) => call<T>(t, "POST", p, b ?? {}, idem),
    put: <T = any>(p: string, b?: unknown) => call<T>(t, "PUT", p, b ?? {}),
  });

  const login = async (phone: string, appScope: "PASSENGER" | "DRIVER" | "ADMIN") => {
    const r = await call<{ otpId: string }>(null, "POST", "/v1/auth/otp/request", { phone, appScope });
    const code = sms.lastTo(normalizeNigerianPhone(phone)!)!.body.match(/\d{6}/)![0];
    const t = await call<{ accessToken: string }>(null, "POST", "/v1/auth/otp/verify", { otpId: r.otpId, code, appScope, device: { installId: `demo-${phone}-${appScope}`, platform: "ANDROID" } });
    return t.accessToken;
  };

  const admin = as(await login("+2348000000001", "ADMIN"));
  const me = await admin.get("/v1/admin/me").catch(() => null);
  if (!me) throw new Error("Seed the admin first: SEED_ADMIN_PHONE=+2348000000001 pnpm db:seed");

  // ---------------- drivers ----------------
  const driverSpecs = [
    { phone: "08060000101", first: "Ibrahim", last: "Sule", car: ["Toyota", "Corolla", 2016, "Silver"], plate: "BWR 482 KD", cat: "economy", at: P.wuse2 },
    { phone: "08060000102", first: "Musa", last: "Bello", car: ["Toyota", "Camry", 2018, "Grey"], plate: "ABC 731 FG", cat: "comfort", at: P.maitama },
    { phone: "08060000103", first: "Chinedu", last: "Eze", car: ["Honda", "Accord", 2015, "Black"], plate: "KUJ 208 AB", cat: "economy", at: P.jabi },
    { phone: "08060000104", first: "Peter", last: "Nwosu", car: ["Lexus", "RX 350", 2017, "White"], plate: "GWA 590 CD", cat: "suv", at: P.asokoro },
    { phone: "08060000105", first: "Aliyu", last: "Tanko", car: ["Kia", "Rio", 2019, "Red"], plate: "BWR 337 EF", cat: "economy", at: P.garki },
    { phone: "08060000106", first: "Yusuf", last: "Danjuma", car: ["Toyota", "Corolla", 2014, "Blue"], plate: "ABJ 144 XY", cat: "economy", at: P.gwarinpa },
    { phone: "08060000107", first: "Sani", last: "Kabir", car: ["Toyota", "Corolla", 2017, "White"], plate: "BWR 119 LA", cat: "economy", at: P.kubwa },
    { phone: "08060000108", first: "Fatima", last: "Ahmed", car: ["Hyundai", "Elantra", 2018, "Silver"], plate: "ABJ 902 MN", cat: "economy", at: P.cbd },
  ];
  const pendingSpecs = [
    { phone: "08060000201", first: "Grace", last: "Okafor", car: ["Toyota", "Highlander", 2019, "Black"], plate: "AMC 902 JK", cat: "suv" },
    { phone: "08060000202", first: "Emeka", last: "Obi", car: ["Hyundai", "Elantra", 2017, "Grey"], plate: "ABJ 671 LM", cat: "comfort" },
    { phone: "08060000203", first: "Halima", last: "Yakubu", car: ["Toyota", "Corolla", 2015, "Gold"], plate: "KUJ 404 HY", cat: "economy" },
  ];

  const drivers: Record<string, { api: ReturnType<typeof as>; id: string; spec: (typeof driverSpecs)[number]; pos: { lat: number; lng: number } }> = {};
  let hbSeq = 1_000_000;
  // Like the real driver app, keep sending location while online so the heartbeat never lapses.
  const heartbeat = setInterval(() => {
    for (const d of Object.values(drivers)) {
      d.api.post("/v1/driver/location", { ...d.pos, recordedAt: new Date().toISOString(), clientSeq: ++hbSeq }).catch(() => d.api.post("/v1/driver/availability/online", d.pos).catch(() => undefined));
    }
  }, 8000);
  const register = async (s: { phone: string; first: string; last: string; car: (string | number)[]; plate: string; cat: string }) => {
    const d = as(await login(s.phone, "DRIVER"));
    await d.post("/v1/me/profile", { firstName: s.first, lastName: s.last, termsVersion: "2026-11" });
    const existing = await d.get("/v1/driver/me");
    const onboard = existing ?? (await d.post("/v1/driver/onboarding", { licenceNumber: `ABJ${s.phone.slice(-5)}AA01`, licenceExpiresAt: "2029-03-01", addressLine: "Plot 12, Gimbiya Street, Garki" }));
    let vehicleId: string | undefined = existing?.vehicles?.[0]?.id;
    if (!vehicleId) vehicleId = (await d.post("/v1/driver/vehicles", { categoryKey: s.cat, make: s.car[0], model: s.car[1], year: s.car[2], colour: s.car[3], plateNumber: s.plate })).id;
    return { d, driverId: onboard.id as string, vehicleId: vehicleId! };
  };

  for (const s of driverSpecs) {
    const { d, driverId, vehicleId } = await register(s);
    await admin.post(`/v1/admin/vehicles/${vehicleId}/approve`).catch(() => undefined);
    await admin.post(`/v1/admin/drivers/${driverId}/approve`).catch(() => undefined);
    await d.post("/v1/driver/availability/online", s.at).catch(() => undefined);
    drivers[s.first] = { api: d, id: driverId, spec: s, pos: { lat: s.at.lat, lng: s.at.lng } };
  }
  if (!onlineOnly) for (const s of pendingSpecs) await register(s);
  console.log(`Drivers: ${driverSpecs.length} approved and online, ${pendingSpecs.length} waiting for verification`);

  if (!onlineOnly) {
  // ---------------- passengers ----------------
  const paxSpecs = [
    ["08030000301", "Amaka", "Okonkwo"], ["08030000302", "Tunde", "Adeyemi"], ["08030000303", "Hauwa", "Musa"], ["08030000304", "Femi", "Kolawole"],
    ["08030000305", "Zainab", "Yusuf"], ["08030000306", "Ngozi", "Ibe"], ["08030000307", "Ifeanyi", "Chukwu"], ["08030000308", "Blessing", "Akpan"],
    ["08030000309", "Kelechi", "Udo"], ["08030000310", "Victor", "Ade"],
  ] as const;
  const pax: Record<string, ReturnType<typeof as>> = {};
  for (const [phone, first, last] of paxSpecs) {
    pax[first] = as(await login(phone, "PASSENGER"));
    await pax[first]!.post("/v1/me/profile", { firstName: first, lastName: last, termsVersion: "2026-11", email: `${first.toLowerCase()}@example.com` }).catch(() => undefined);
  }
  // Two passengers top up their wallets at the hub (audited admin adjustments).
  for (const name of ["Hauwa", "Ngozi"]) {
    const w = await admin.get(`/v1/admin/finance/wallets?q=${encodeURIComponent(name)}`);
    const hit = w.find((x: { ownerType: string }) => x.ownerType === "PASSENGER");
    if (hit) await admin.post(`/v1/admin/finance/wallets/${hit.userId}/adjust`, { ownerType: "PASSENGER", direction: "CREDIT", amount: "2000000", reason: "Cash top-up at Wuse hub" });
  }

  // ---------------- trips ----------------
  const book = async (who: string, from: Place, to: Place, cat: string, delta: bigint, method: "CASH" | "WALLET") => {
    const p = pax[who]!;
    const est = await p.post("/v1/ride-requests/estimate", { pickup: from, dropoff: to, categoryKey: cat });
    const fare = (BigInt(est.categories[0].suggestedFare) + delta).toString();
    const req = await p.post("/v1/ride-requests", { pickup: from, dropoff: to, categoryKey: cat, proposedFare: fare, paymentMethod: method }, true);
    return { id: req.id as string, fare: BigInt(fare) };
  };
  const negotiate = async (who: string, reqId: string, driverName: string, counter?: bigint) => {
    const d = drivers[driverName]!.api;
    await d.post(`/v1/ride-requests/${reqId}/offers`, counter ? { amount: counter.toString() } : { acceptPassengerPrice: true }, true);
    const r = await pax[who]!.get(`/v1/ride-requests/${reqId}`);
    const offer = r.offers.find((o: { driver: { firstName: string } }) => o.driver.firstName === driverName);
    const acc = await pax[who]!.post(`/v1/ride-requests/${reqId}/offers/${offer.id}/accept`, {}, true);
    return acc.rideId as string;
  };
  const ping = (driverName: string, at: { lat: number; lng: number }, seq: number) => {
    drivers[driverName]!.pos = at;
    return drivers[driverName]!.api.post("/v1/driver/location", { ...at, recordedAt: new Date().toISOString(), clientSeq: seq + Math.floor(Math.random() * 1000) * 100 });
  };
  const drive = async (who: string, driverName: string, rideId: string, from: Place, to: Place, stopAt: "enroute" | "started" | "done", stars?: number) => {
    const d = drivers[driverName]!.api;
    await d.post(`/v1/rides/${rideId}/en-route`);
    if (stopAt === "enroute") return;
    await ping(driverName, from, 1);
    await d.post(`/v1/rides/${rideId}/arrived`);
    const pin = (await pax[who]!.get(`/v1/rides/${rideId}`)).tripPin;
    await d.post(`/v1/rides/${rideId}/start`, { pin });
    for (let i = 1; i <= 5; i++) {
      await ping(driverName, { lat: from.lat + ((to.lat - from.lat) * i) / 6, lng: from.lng + ((to.lng - from.lng) * i) / 6 }, i + 1);
      await new Promise((r) => setTimeout(r, 5200)); // breadcrumbs are stored at most every 5 s
    }
    if (stopAt === "started") return;
    await ping(driverName, to, 9);
    await d.post(`/v1/rides/${rideId}/complete`, to, true);
    if (stars) {
      await pax[who]!.post(`/v1/rides/${rideId}/ratings`, { stars, comment: stars === 5 ? "Smooth ride, clean car" : undefined });
      await d.post(`/v1/rides/${rideId}/ratings`, { stars: 5 });
    }
    await ping(driverName, to, 10);
  };

  const trips: Array<[string, Place, Place, string, bigint, "CASH" | "WALLET", string, bigint | undefined, number]> = [
    ["Amaka", P.wuse2, P.airport, "economy", -50000n, "CASH", "Ibrahim", 50000n, 5],
    ["Tunde", P.maitama, P.jabi, "comfort", 0n, "CASH", "Musa", 40000n, 5],
    ["Hauwa", P.jabi, P.gwarinpa, "economy", 0n, "WALLET", "Chinedu", undefined, 4],
    ["Femi", P.garki, P.lugbe, "economy", -30000n, "CASH", "Aliyu", 30000n, 5],
    ["Ngozi", P.asokoro, P.wusemarket, "suv", 0n, "WALLET", "Peter", undefined, 5],
    ["Ifeanyi", P.gwarinpa, P.lifecamp, "economy", 0n, "CASH", "Yusuf", undefined, 3],
  ];
  for (const [who, from, to, cat, delta, method, drv, counter, stars] of trips) {
    await ping(drv, near(from, 0.001), 0);
    const req = await book(who, from, to, cat, delta, method);
    const rideId = await negotiate(who, req.id, drv, counter ? req.fare + counter : undefined);
    await drive(who, drv, rideId, from, to, "done", stars);
    console.log(`Completed ${who} with ${drv}: ${from.address.split(",")[0]} → ${to.address.split(",")[0]}`);
  }

  // A cancelled trip, two live trips, an open request with offers.
  await ping("Fatima", near(P.cbd, 0.001), 0);
  const zc = await book("Zainab", P.cbd, P.kubwa, "economy", 0n, "CASH");
  const zr = await negotiate("Zainab", zc.id, "Fatima");
  await drivers.Fatima!.api.post(`/v1/rides/${zr}/en-route`);
  await pax.Zainab!.post(`/v1/rides/${zr}/cancel`, { reasonCode: "CHANGED_PLANS" });

  await ping("Ibrahim", near(P.airport, 0.003), 20);
  const live1 = await book("Kelechi", P.airport, P.cbd, "economy", 0n, "CASH");
  const r1 = await negotiate("Kelechi", live1.id, "Ibrahim", live1.fare + 50000n);
  await drive("Kelechi", "Ibrahim", r1, P.airport, P.cbd, "enroute");

  await ping("Sani", near(P.kubwa, 0.001), 0);
  const live2 = await book("Blessing", P.kubwa, P.utako, "economy", 0n, "CASH");
  const r2 = await negotiate("Blessing", live2.id, "Sani", live2.fare + 30000n);
  await drive("Blessing", "Sani", r2, P.kubwa, P.utako, "started");

  await ping("Musa", near(P.banex, 0.001), 30);
  await ping("Chinedu", near(P.banex, 0.002), 30);
  const open = await book("Victor", P.banex, P.asokoro, "economy", -20000n, "CASH");
  await drivers.Chinedu!.api.post(`/v1/ride-requests/${open.id}/offers`, { amount: (open.fare + 50000n).toString() }, true).catch(() => undefined);
  console.log("Live: 2 trips in progress, 1 open request with an offer, 1 cancelled trip");

  // ---------------- payouts, support, safety ----------------
  for (const [name, bank, acct] of [["Ibrahim", "GTBank", "0123455520"], ["Peter", "Access Bank", "0098760912"]] as const) {
    const d = drivers[name]!.api;
    const me = await d.get("/v1/me");
    await admin.post(`/v1/admin/finance/wallets/${me.id}/adjust`, { ownerType: "DRIVER", direction: "CREDIT", amount: "6400000", reason: "Weekly incentive: 40 trips" });
    await d.put("/v1/driver/bank-account", { bankName: bank, accountName: `${drivers[name]!.spec.first} ${drivers[name]!.spec.last}`, accountNumber: acct });
    await d.post("/v1/driver/withdrawals", { amount: name === "Ibrahim" ? "5000000" : "3500000" }, true).catch(() => undefined);
  }

  const amaka = await pax.Amaka!.get("/v1/rides");
  await pax.Hauwa!.post("/v1/support/tickets", { category: "PAYMENT", subject: "Wallet charged but trip was short", body: "My wallet was charged the full fare but the driver ended the trip early at Gwarinpa." });
  await pax.Amaka!.post("/v1/support/tickets", { category: "LOST_PROPERTY", subject: "Left my laptop bag in the car", body: "Black laptop bag on the back seat. Please help me reach the driver.", rideId: amaka.data[0]?.id });
  await drivers.Aliyu!.api.post("/v1/support/tickets", { category: "PAYMENT", subject: "Commission looks too high", body: "I was charged commission twice this morning, please check." });
  await pax.Blessing!.post("/v1/safety/sos", { rideId: r2, lat: 9.1302, lng: 7.3651 });
  console.log("Payout requests: 2 · tickets: 3 · SOS: 1 open");
  }

  clearInterval(heartbeat);
  if (keepMinutes > 0) {
    console.log(`Keeping demo drivers online for ${keepMinutes} minutes (Ctrl+C to stop)…`);
    const end = Date.now() + keepMinutes * 60_000;
    let seq = 5_000_000;
    while (Date.now() < end) {
      for (const [name, d] of Object.entries(drivers)) {
        const jitter = (Math.random() - 0.5) * 0.004;
        d.pos = { lat: d.pos.lat + jitter / 4, lng: d.pos.lng + jitter / 4 };
        await d.api.post("/v1/driver/location", { ...d.pos, recordedAt: new Date().toISOString(), clientSeq: ++seq }).catch(() => d.api.post("/v1/driver/availability/online", d.pos).catch(() => undefined));
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  await close();
  console.log("Done.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
