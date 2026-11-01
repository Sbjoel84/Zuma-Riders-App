import { Logger } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer, ConnectedSocket, MessageBody } from "@nestjs/websockets";
import { LocationPoint } from "@zuma/contracts";
import type { Namespace, Socket } from "socket.io";
import { DomainError } from "../../common/errors";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";
import { TokensService } from "../auth/tokens.service";
import { AvailabilityService } from "../geo/availability.service";
import { ACTIVE_RIDE_STATUSES } from "../rides/state-machine";
import { EventsService } from "./events.service";

interface SocketData {
  userId: string;
  scope: "PASSENGER" | "DRIVER" | "ADMIN";
  driverId?: string;
}

/**
 * Socket.IO namespace /rt. Clients authenticate with the access token in the handshake.
 * Clients only SEND high-frequency, low-stakes data here (location, heartbeat); anything that changes
 * ride state or money is a REST call (ADR-008).
 */
@WebSocketGateway({ namespace: "/rt", cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly log = new Logger("Realtime");
  @WebSocketServer() ns!: Namespace;

  constructor(
    private readonly tokens: TokensService,
    private readonly events: EventsService,
    private readonly availability: AvailabilityService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  afterInit(ns: Namespace) {
    this.events.attach(ns);
    ns.use(async (socket, next) => {
      try {
        const token = (socket.handshake.auth?.token as string | undefined) ?? (socket.handshake.headers.authorization as string | undefined)?.replace("Bearer ", "");
        if (!token) return next(new Error("UNAUTHENTICATED"));
        const auth = await this.tokens.verifyAccess(token);
        if (await this.redis.client.exists(`sess:revoked:${auth.sessionId}`)) return next(new Error("UNAUTHENTICATED"));
        const data: SocketData = { userId: auth.userId, scope: auth.scope };
        if (auth.scope === "DRIVER") {
          const d = await this.prisma.db.driver.findUnique({ where: { userId: auth.userId }, select: { id: true } });
          data.driverId = d?.id;
        }
        socket.data = data;
        next();
      } catch {
        next(new Error("UNAUTHENTICATED"));
      }
    });
  }

  async handleConnection(socket: Socket) {
    const data = socket.data as SocketData;
    if (!data?.userId) return socket.disconnect(true);
    await socket.join(`user:${data.userId}`);
    if (data.driverId) await socket.join(`driver:${data.driverId}`);
    // Rejoin the active ride room after a reconnect.
    const ride = await this.prisma.db.ride.findFirst({
      where: {
        status: { in: ACTIVE_RIDE_STATUSES },
        OR: [{ passenger: { userId: data.userId } }, { driver: { userId: data.userId } }],
      },
      select: { id: true },
    });
    if (ride) await socket.join(`ride:${ride.id}`);
    if (data.scope === "ADMIN") {
      const cities = await this.prisma.db.city.findMany({ where: { isLive: true }, select: { id: true } });
      await Promise.all(cities.map((c) => socket.join(`admin:ops:${c.id}`)));
    }
    socket.emit("ready", { userId: data.userId, rideId: ride?.id ?? null });
  }

  @SubscribeMessage("driver.location")
  async onLocation(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const data = socket.data as SocketData;
    if (!data.driverId) return { ok: false, error: "FORBIDDEN" };
    const parsed = LocationPoint.safeParse(body);
    if (!parsed.success) return { ok: false, error: "VALIDATION_FAILED" };
    try {
      const rideId = await this.availability.updateLocation(data.driverId, parsed.data);
      return { ok: true, rideId };
    } catch (e) {
      return { ok: false, error: e instanceof DomainError ? e.code : "INTERNAL" };
    }
  }

  @SubscribeMessage("driver.heartbeat")
  async onHeartbeat(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    return this.onLocation(socket, body);
  }
}
