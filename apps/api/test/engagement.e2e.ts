/**
 * Driver documents (upload → review → approval gate), push notifications, rider–driver chat,
 * emergency contacts on SOS and the public trip-share page.
 */
import { randomUUID } from "crypto";
import { resetEnvCache } from "../src/config/env";
import { PLACES, TestApp, waitFor } from "./helpers";

const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");

describe("documents, chat, push and safety contacts", () => {
  const t = new TestApp();
  let admin: string;

  beforeAll(async () => {
    await t.start();
    admin = (await t.login("+2348000000001", "ADMIN")).accessToken;
  });
  afterAll(async () => {
    process.env.DRIVER_DOCS_REQUIRED = "false";
    resetEnvCache();
    await t.stop();
  });

  async function upload(token: string, purpose = "DRIVER_DOCUMENT", mimeType = "image/jpeg", data = JPEG) {
    const u = await t.api(token).post("/v1/files/uploads", { purpose, mimeType, sizeBytes: data.length }).expect(201);
    const path = new URL(u.body.uploadUrl).pathname;
    await t.http().put(path).set("Content-Type", mimeType).send(data).expect(200);
    return u.body.fileId as string;
  }

  it("requires approved documents before a driver and vehicle can be approved", async () => {
    process.env.DRIVER_DOCS_REQUIRED = "true";
    resetEnvCache();
    const d = await t.login("08072220001", "DRIVER");
    const D = t.api(d.accessToken);
    await D.post("/v1/me/profile", { firstName: "Yusuf", lastName: "Bello", termsVersion: "2026-11" }).expect(201);
    const onboard = await D.post("/v1/driver/onboarding", { licenceNumber: "ABJ55555AA01", licenceExpiresAt: "2029-03-01", addressLine: "4 Ademola Adetokunbo, Wuse 2" }).expect(201);
    const veh = await D.post("/v1/driver/vehicles", { categoryKey: "economy", make: "Toyota", model: "Camry", year: 2015, colour: "Black", plateNumber: "ABJ 777 DC" }).expect(201);
    await D.post("/v1/driver/availability/online", PLACES.wuse2).expect(403);

    let docs = (await D.get("/v1/driver/documents").expect(200)).body;
    expect(docs).toMatchObject({ required: true, complete: false });
    expect(docs.driver.map((x: { status: string }) => x.status)).toEqual(["MISSING", "MISSING", "MISSING"]);

    // Approval is blocked while documents are missing.
    const A = t.api(admin);
    const blocked = await A.post(`/v1/admin/drivers/${onboard.body.id}/approve`).expect(422);
    expect(blocked.body.error.code).toBe("DOCUMENTS_INCOMPLETE");

    // Validation: expired documents and missing numbers are refused; files can't be reused.
    const f0 = await upload(d.accessToken);
    await D.post("/v1/driver/documents", { type: "DRIVERS_LICENCE", fileId: f0, documentNumber: "ABJ55555AA01", expiresAt: "2020-01-01" }).expect(422);
    await D.post("/v1/driver/documents", { type: "DRIVERS_LICENCE", fileId: f0, expiresAt: "2029-03-01" }).expect(422);
    await D.post("/v1/driver/documents", { type: "DRIVERS_LICENCE", fileId: f0, documentNumber: "ABJ55555AA01", expiresAt: "2029-03-01" }).expect(201);
    await D.post("/v1/driver/documents", { type: "NATIONAL_ID", fileId: f0, documentNumber: "12345678901" }).expect(422);
    // A file id that was never uploaded is refused.
    const ghost = await D.post("/v1/files/uploads", { purpose: "DRIVER_DOCUMENT", mimeType: "image/jpeg", sizeBytes: 100 }).expect(201);
    expect((await D.post("/v1/driver/documents", { type: "NATIONAL_ID", fileId: ghost.body.fileId, documentNumber: "12345678901" }).expect(422)).body.error.code).toBe("FILE_INVALID");

    await D.post("/v1/driver/documents", { type: "NATIONAL_ID", fileId: await upload(d.accessToken), documentNumber: "12345678901" }).expect(201);
    await D.post("/v1/driver/documents", { type: "PROFILE_PHOTO", fileId: await upload(d.accessToken) }).expect(201);
    for (const [type, extra] of [["VEHICLE_REGISTRATION", { expiresAt: "2027-06-30" }], ["ROADWORTHINESS", { expiresAt: "2027-06-30" }], ["INSURANCE", { documentNumber: "POL-88231", expiresAt: "2027-06-30" }], ["PHOTO_FRONT", {}], ["PHOTO_BACK", {}]] as const) {
      await D.post(`/v1/driver/vehicles/${veh.body.id}/documents`, { type, fileId: await upload(d.accessToken, "VEHICLE_DOCUMENT"), ...extra }).expect(201);
    }
    docs = (await D.get("/v1/driver/documents").expect(200)).body;
    expect(docs.complete).toBe(true);

    // Reviewer sees signed links that actually serve the file.
    const review = (await A.get(`/v1/admin/drivers/${onboard.body.id}/documents`).expect(200)).body;
    const photo = review.driver.find((x: { type: string }) => x.type === "PROFILE_PHOTO");
    const file = await t.http().get(new URL(photo.url).pathname).expect(200);
    expect(file.headers["content-type"]).toBe("image/jpeg");
    await t.http().get("/v1/files/local/forged.token").expect(403);

    // Reject the selfie with a reason → driver is told; re-upload; approve everything.
    await A.post(`/v1/admin/documents/driver/${photo.id}/reject`, {}).expect(422);
    await t.api(d.accessToken).post("/v1/me/push-tokens", { token: "ExponentPushToken[yusuf]", platform: "ANDROID" }).expect(204);
    await A.post(`/v1/admin/documents/driver/${photo.id}/reject`, { reason: "Photo is blurry. Retake in good light." }).expect(200);
    const userId = (await D.get("/v1/me")).body.id;
    expect((await t.pushes(userId)).at(-1)).toMatchObject({ title: "Profile photo needs another upload", body: "Photo is blurry. Retake in good light." });
    docs = (await D.get("/v1/driver/documents").expect(200)).body;
    expect(docs.driver.find((x: { type: string }) => x.type === "PROFILE_PHOTO")).toMatchObject({ status: "REJECTED", rejectionReason: "Photo is blurry. Retake in good light." });
    await D.post("/v1/driver/documents", { type: "PROFILE_PHOTO", fileId: await upload(d.accessToken) }).expect(201);

    const fresh = (await A.get(`/v1/admin/drivers/${onboard.body.id}/documents`).expect(200)).body;
    for (const doc of fresh.driver) await A.post(`/v1/admin/documents/driver/${doc.id}/approve`).expect(200);
    await A.post(`/v1/admin/drivers/${onboard.body.id}/approve`).expect(200);
    expect((await A.post(`/v1/admin/vehicles/${veh.body.id}/approve`).expect(422)).body.error.code).toBe("DOCUMENTS_INCOMPLETE");
    for (const doc of fresh.vehicles[0].documents) await A.post(`/v1/admin/documents/vehicle/${doc.id}/approve`).expect(200);
    await A.post(`/v1/admin/vehicles/${veh.body.id}/approve`).expect(200);
    await D.post("/v1/driver/availability/online", PLACES.wuse2).expect(200);
    expect((await t.pushes(userId)).map((p) => p.title)).toEqual(expect.arrayContaining(["You're approved to drive", "Vehicle approved"]));
    await D.post("/v1/driver/availability/offline").expect(200);

    process.env.DRIVER_DOCS_REQUIRED = "false";
    resetEnvCache();
  });

  it("runs trip chat over REST + socket with push, read receipts, flagging and closing", async () => {
    const pax = await t.passenger("08032220011", "Ngozi");
    const drv = await t.onlineDriver("08062220011", "Garba", "ABJ 811 CH", PLACES.maitama, admin);
    const P = t.api(pax.accessToken);
    const D = t.api(drv.accessToken);
    await P.post("/v1/me/push-tokens", { token: "ExponentPushToken[ngozi]", platform: "IOS" }).expect(204);

    const est = await P.post("/v1/ride-requests/estimate", { pickup: PLACES.maitama, dropoff: PLACES.wuse2, categoryKey: "economy" }).expect(200);
    const req = await P.post("/v1/ride-requests", { pickup: PLACES.maitama, dropoff: PLACES.wuse2, categoryKey: "economy", proposedFare: est.body.categories[0].suggestedFare, paymentMethod: "CASH" }, true).expect(201);
    const paxId = (await P.get("/v1/me")).body.id;
    expect((await t.pushes(paxId)).length).toBe(0);
    await D.post(`/v1/ride-requests/${req.body.id}/offers`, { acceptPassengerPrice: true }, true).expect(201);
    expect((await t.pushes(paxId)).at(-1)?.title).toMatch(/^Garba offered ₦/);
    const offerId = (await P.get(`/v1/ride-requests/${req.body.id}`)).body.offers[0].id;
    const { rideId } = (await P.post(`/v1/ride-requests/${req.body.id}/offers/${offerId}/accept`, {}, true).expect(200)).body;

    const ps = await t.socket(pax.accessToken);
    const got = waitFor<{ data: { rideId: string; message: { body: string; fromMe: boolean; senderRole: string } } }>(ps, "chat.message", (e) => e.data.message.senderRole === "DRIVER");
    const cmid = randomUUID();
    const sent = await D.post(`/v1/rides/${rideId}/messages`, { clientMessageId: cmid, body: "I'm at the gate, white Corolla" }).expect(201);
    expect(sent.body).toMatchObject({ fromMe: true, senderRole: "DRIVER" });
    const ev = await got;
    expect(ev.data.message).toMatchObject({ body: "I'm at the gate, white Corolla", fromMe: false });
    expect((await t.pushes(paxId)).at(-1)).toMatchObject({ title: "Garba", body: "I'm at the gate, white Corolla" });
    // Resending the same client id doesn't duplicate.
    await D.post(`/v1/rides/${rideId}/messages`, { clientMessageId: cmid, body: "I'm at the gate, white Corolla" }).expect(201);
    expect((await P.get(`/v1/rides/${rideId}`)).body.unreadMessages).toBe(1);
    await P.post(`/v1/rides/${rideId}/messages/read`).expect(200);
    expect((await P.get(`/v1/rides/${rideId}`)).body.unreadMessages).toBe(0);

    // Photo message + phone number flag
    const img = await upload(pax.accessToken, "CHAT_IMAGE");
    await P.post(`/v1/rides/${rideId}/messages`, { clientMessageId: randomUUID(), attachmentId: img }).expect(201);
    await P.post(`/v1/rides/${rideId}/messages`, { clientMessageId: randomUUID(), body: "call me on 0803 123 4567" }).expect(201);
    await P.post("/v1/files/uploads", { purpose: "CHAT_IMAGE", mimeType: "application/pdf", sizeBytes: 100 }).expect(422);
    const list = (await D.get(`/v1/rides/${rideId}/messages`).expect(200)).body;
    expect(list).toMatchObject({ open: true, otherName: "Ngozi" });
    expect(list.messages.map((m: { type: string }) => m.type)).toEqual(["TEXT", "IMAGE", "TEXT"]);
    expect(list.messages[1].imageUrl).toContain("/v1/files/local/");

    // Outsiders can't read it; support can, with flags.
    const other = await t.passenger("08032220012", "Stranger");
    await t.api(other.accessToken).get(`/v1/rides/${rideId}/messages`).expect(404);
    const detail = (await t.api(admin).get(`/v1/admin/rides/${rideId}`).expect(200)).body;
    expect(detail.chat.map((m: { flagged: boolean }) => m.flagged)).toEqual([false, false, true]);

    // Cancel → chat stays open for the grace window, then closes.
    await D.post(`/v1/rides/${rideId}/cancel`, { reasonCode: "PASSENGER_NO_SHOW" }).expect(200);
    expect((await t.pushes(paxId)).at(-1)).toMatchObject({ title: "Trip cancelled" });
    await P.post(`/v1/rides/${rideId}/messages`, { clientMessageId: randomUUID(), body: "No problem" }).expect(201);
    process.env.CHAT_OPEN_AFTER_TRIP_S = "0";
    resetEnvCache();
    const closed = await P.post(`/v1/rides/${rideId}/messages`, { clientMessageId: randomUUID(), body: "Hello?" }).expect(409);
    expect(closed.body.error.code).toBe("CHAT_CLOSED");
    delete process.env.CHAT_OPEN_AFTER_TRIP_S;
    resetEnvCache();

    // Inbox and preferences
    const inbox = (await P.get("/v1/me/notifications").expect(200)).body;
    expect(inbox.unread).toBeGreaterThan(0);
    await P.post("/v1/me/notifications/read-all").expect(204);
    expect((await P.get("/v1/me/notifications")).body.unread).toBe(0);
    await P.put("/v1/me/notification-preferences", { category: "CHAT", enabled: false }).expect(200);
    await D.post("/v1/driver/availability/offline").expect(200);
  });

  it("texts emergency contacts on SOS (once per incident) and shares a live trip page", async () => {
    const pax = await t.passenger("08032220021", "Amaka");
    const drv = await t.onlineDriver("08062220021", "Babatunde", "ABJ 921 SS", PLACES.maitama, admin);
    const P = t.api(pax.accessToken);

    await P.post("/v1/me/emergency-contacts", { name: "Me", phone: "08032220021" }).expect(422);
    await P.post("/v1/me/emergency-contacts", { name: "Chioma (sister)", phone: "0809 555 0001", relationship: "Sister" }).expect(201);
    await P.post("/v1/me/emergency-contacts", { name: "Chioma again", phone: "+2348095550001" }).expect(422);
    const contacts = (await P.post("/v1/me/emergency-contacts", { name: "Obinna", phone: "08095550002" }).expect(201)).body;
    expect(contacts).toHaveLength(2);

    const est = await P.post("/v1/ride-requests/estimate", { pickup: PLACES.maitama, dropoff: PLACES.jabi, categoryKey: "economy" }).expect(200);
    const req = await P.post("/v1/ride-requests", { pickup: PLACES.maitama, dropoff: PLACES.jabi, categoryKey: "economy", proposedFare: est.body.categories[0].suggestedFare, paymentMethod: "CASH" }, true).expect(201);
    await t.api(drv.accessToken).post(`/v1/ride-requests/${req.body.id}/offers`, { acceptPassengerPrice: true }, true).expect(201);
    const offerId = (await P.get(`/v1/ride-requests/${req.body.id}`)).body.offers[0].id;
    const { rideId } = (await P.post(`/v1/ride-requests/${req.body.id}/offers/${offerId}/accept`, {}, true).expect(200)).body;

    const share = await P.post(`/v1/rides/${rideId}/share`, { notifyContacts: true }).expect(201);
    expect(share.body.contactsNotified).toBe(2);
    expect(t.smsTo("08095550001").at(-1)?.body).toContain("ABJ 921 SS");
    const page = await t.http().get(new URL(share.body.url).pathname).expect(200);
    expect(page.text).toContain("Amaka is on a Riders App trip");
    expect(page.text).toContain("ABJ 921 SS");
    expect(page.text).not.toContain("0803"); // no phone numbers on the public page

    const sos = await P.post("/v1/safety/sos", { rideId, lat: 9.08, lng: 7.49 }).expect(201);
    expect(sos.body).toMatchObject({ opsAlerted: true, contactsNotified: 2, emergencyServicesContacted: false });
    expect(t.smsTo("08095550002").at(-1)?.body).toMatch(/URGENT: Amaka Test pressed SOS.*ABJ 921 SS.*maps\.google\.com\/\?q=9\.08000,7\.49000/);
    const again = await P.post("/v1/safety/sos", { rideId, lat: 9.081, lng: 7.491 }).expect(201);
    expect(again.body.contactsNotified).toBe(0);
    expect(again.body.incidentId).toBe(sos.body.incidentId);

    await t.api(drv.accessToken).post(`/v1/rides/${rideId}/cancel`, { reasonCode: "OTHER" }).expect(200);
    const ended = await t.http().get(new URL(share.body.url).pathname).expect(404);
    expect(ended.text).toContain("ended");
    await t.api(drv.accessToken).post("/v1/driver/availability/offline").expect(200);
  });
});
