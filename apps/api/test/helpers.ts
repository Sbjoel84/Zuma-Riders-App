import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "crypto";
import { io, Socket } from "socket.io-client";
import request from "supertest";
import { normalizeNigerianPhone } from "@zuma/contracts";
import { createApp } from "../src/app.factory";
import { SmsService } from "../src/infra/sms.service";

export const PLACES = {
  wuse2: { lat: 9.0765, lng: 7.479, address: "Wuse 2, Aminu Kano Crescent, Abuja" },
  nearWuse2: { lat: 9.0772, lng: 7.4801, address: "Banex Plaza, Wuse 2" },
  airport: { lat: 9.0068, lng: 7.2632, address: "Nnamdi Azikiwe International Airport, Abuja" },
  jabi: { lat: 9.0703, lng: 7.4247, address: "Jabi Lake Mall, Jabi, Abuja" },
  maitama: { lat: 9.0882, lng: 7.4934, address: "Maitama District, Abuja" },
  lagos: { lat: 6.5244, lng: 3.3792, address: "Lagos Island" },
};

export class TestApp {
  app!: INestApplication;
  close!: () => Promise<void>;
  port!: number;
  sockets: Socket[] = [];

  async start() {
    const { app, close } = await createApp();
    this.app = app;
    this.close = close;
    await app.listen(0, "127.0.0.1");
    this.port = (app.getHttpServer().address() as { port: number }).port;
    return this;
  }

  async stop() {
    this.sockets.forEach((s) => s.disconnect());
    await this.close();
  }

  http() {
    return request(this.app.getHttpServer());
  }

  api(token: string) {
    const h = this.http();
    const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
    return {
      get: (url: string) => auth(h.get(url)),
      post: (url: string, body?: object, idem?: string | true) => {
        let r = auth(h.post(url)).send(body ?? {});
        if (idem) r = r.set("Idempotency-Key", idem === true ? randomUUID() : idem);
        return r;
      },
      patch: (url: string, body?: object) => auth(h.patch(url)).send(body ?? {}),
      put: (url: string, body?: object) => auth(h.put(url)).send(body ?? {}),
    };
  }

  /** Full OTP sign-in, reading the code from the console SMS outbox. */
  async login(phone: string, appScope: "PASSENGER" | "DRIVER" | "ADMIN") {
    const req = await this.http().post("/v1/auth/otp/request").send({ phone, appScope }).expect(200);
    const sms = this.app.get(SmsService).lastTo(normalizeNigerianPhone(phone) ?? phone);
    if (!sms) throw new Error(`No SMS sent to ${phone}`);
    const code = sms.body.match(/\d{6}/)![0];
    const res = await this.http()
      .post("/v1/auth/otp/verify")
      .send({ otpId: req.body.otpId, code, appScope, device: { installId: `test-${phone}-${appScope}`, platform: "ANDROID" } })
      .expect(200);
    return res.body as { accessToken: string; refreshToken: string; isNewUser: boolean };
  }

  async passenger(phone: string, firstName: string) {
    const t = await this.login(phone, "PASSENGER");
    await this.api(t.accessToken).post("/v1/me/profile", { firstName, lastName: "Test", termsVersion: "2026-11" }).expect(201);
    return t;
  }

  /** Registers, approves (as admin) and brings a driver online at `at`. */
  async onlineDriver(phone: string, firstName: string, plate: string, at: { lat: number; lng: number }, adminToken: string, categoryKey = "economy") {
    const t = await this.login(phone, "DRIVER");
    const api = this.api(t.accessToken);
    await api.post("/v1/me/profile", { firstName, lastName: "Driver", termsVersion: "2026-11" }).expect(201);
    const onboard = await api.post("/v1/driver/onboarding", { licenceNumber: "ABJ12345AA01", licenceExpiresAt: "2029-03-01", addressLine: "12 Gimbiya Street, Garki" }).expect(201);
    const veh = await api.post("/v1/driver/vehicles", { categoryKey, make: "Toyota", model: "Corolla", year: 2016, colour: "Silver", plateNumber: plate }).expect(201);
    const admin = this.api(adminToken);
    await admin.post(`/v1/admin/drivers/${onboard.body.id}/approve`).expect(200);
    await admin.post(`/v1/admin/vehicles/${veh.body.id}/approve`).expect(200);
    await api.post("/v1/driver/availability/online", at).expect(200);
    return { ...t, driverId: onboard.body.id as string, vehicleId: veh.body.id as string };
  }

  async socket(token: string): Promise<Socket> {
    const s = io(`http://127.0.0.1:${this.port}/rt`, { auth: { token }, transports: ["websocket"], forceNew: true });
    this.sockets.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once("ready", () => resolve());
      s.once("connect_error", reject);
    });
    return s;
  }
}

export function waitFor<T = { data: unknown }>(s: Socket, event: string, predicate: (e: T) => boolean = () => true, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (e: T) => {
      if (predicate(e)) {
        clearTimeout(timer);
        s.off(event, handler);
        resolve(e);
      }
    };
    s.on(event, handler);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
