import { Injectable } from "@nestjs/common";
import type { ServerEvent } from "@zuma/contracts";
import { randomUUID } from "crypto";
import type { Namespace } from "socket.io";

/**
 * Server → client pushes. Callers only emit AFTER their DB transaction commits, so clients never
 * hear about state that was rolled back. Each event has an eventId for client-side de-duplication.
 */
@Injectable()
export class EventsService {
  private ns: Namespace | null = null;

  attach(ns: Namespace) {
    this.ns = ns;
  }

  private envelope<T>(type: string, data: T): ServerEvent<T> {
    return { eventId: randomUUID(), type, sentAt: new Date().toISOString(), data };
  }

  private json<T>(v: T): T {
    return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
  }

  toUser(userId: string, type: string, data: unknown) {
    this.ns?.to(`user:${userId}`).emit(type, this.envelope(type, this.json(data)));
  }

  toDriver(driverId: string, type: string, data: unknown) {
    this.ns?.to(`driver:${driverId}`).emit(type, this.envelope(type, this.json(data)));
  }

  toRide(rideId: string, type: string, data: unknown) {
    this.ns?.to(`ride:${rideId}`).emit(type, this.envelope(type, this.json(data)));
  }

  toAdmins(cityId: string, type: string, data: unknown) {
    this.ns?.to(`admin:ops:${cityId}`).emit(type, this.envelope(type, this.json(data)));
  }

  /** Put both parties' sockets (on any instance, via the Redis adapter) into the ride room. */
  joinRide(rideId: string, userIds: string[]) {
    userIds.forEach((u) => this.ns?.in(`user:${u}`).socketsJoin(`ride:${rideId}`));
  }

  leaveRide(rideId: string) {
    this.ns?.in(`ride:${rideId}`).socketsLeave(`ride:${rideId}`);
  }
}
