import { Injectable } from "@nestjs/common";
import type { Message } from "@zuma/database";
import { env } from "../../config/env";
import { fail } from "../../common/errors";
import type { AuthContext } from "../../common/http";
import { isUniqueViolation, PrismaService } from "../../infra/prisma.service";
import { StorageService } from "../../infra/storage.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EventsService } from "../realtime/events.service";
import { ACTIVE_RIDE_STATUSES } from "../rides/state-machine";

export interface ChatMessageView {
  id: string;
  clientMessageId: string;
  type: string;
  body: string | null;
  imageUrl: string | null;
  fromMe: boolean;
  senderRole: "PASSENGER" | "DRIVER" | "SYSTEM";
  createdAt: string;
}

/** Nigerian mobile numbers, with or without +234 and separators. */
const PHONE = /(?:\+?234|0)\s*[789]\s*[01](?:[\s-]*\d){8}/;

/**
 * Rider–driver chat for one trip. Open from acceptance until CHAT_OPEN_AFTER_TRIP_S after the trip ends
 * (lost items, "I left my bag"). Messages that contain phone numbers are delivered but flagged, so the
 * safety team can see if people are being pushed off-platform. Support staff read transcripts in the admin.
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly notify: NotificationsService,
    private readonly storage: StorageService,
  ) {}

  private async context(rideId: string, auth: AuthContext) {
    const ride = await this.prisma.db.ride.findUnique({ where: { id: rideId }, include: { passenger: { include: { user: true } }, driver: { include: { user: true } } } });
    if (!ride) fail("NOT_FOUND", "Trip not found");
    const role = ride!.passenger.userId === auth.userId && auth.scope === "PASSENGER" ? "PASSENGER" : ride!.driver.userId === auth.userId && auth.scope === "DRIVER" ? "DRIVER" : null;
    if (!role) fail("NOT_FOUND", "Trip not found");
    return { ride: ride!, role: role as "PASSENGER" | "DRIVER" };
  }

  private open(ride: { status: string; completedAt: Date | null; cancelledAt: Date | null }): boolean {
    if (ACTIVE_RIDE_STATUSES.includes(ride.status as never)) return true;
    const ended = ride.completedAt ?? ride.cancelledAt;
    return Boolean(ended && Date.now() - ended.getTime() < env().CHAT_OPEN_AFTER_TRIP_S * 1000);
  }

  private async conversation(ride: { id: string; passenger: { userId: string }; driver: { userId: string } }) {
    const existing = await this.prisma.db.conversation.findUnique({ where: { rideId: ride.id } });
    if (existing) return existing;
    try {
      return await this.prisma.db.conversation.create({
        data: {
          type: "RIDE", rideId: ride.id,
          participants: { create: [{ userId: ride.passenger.userId, role: "PASSENGER" }, { userId: ride.driver.userId, role: "DRIVER" }] },
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return this.prisma.db.conversation.findUniqueOrThrow({ where: { rideId: ride.id } });
      throw e;
    }
  }

  private async view(m: Message & { attachment?: { objectKey: string } | null }, viewerId: string | null, passengerUserId: string): Promise<ChatMessageView> {
    return {
      id: m.id, clientMessageId: m.clientMessageId, type: m.type, body: m.body,
      imageUrl: m.attachment ? await this.storage.presignGet(m.attachment.objectKey, 3600) : null,
      fromMe: viewerId !== null && m.senderId === viewerId,
      senderRole: !m.senderId ? "SYSTEM" : m.senderId === passengerUserId ? "PASSENGER" : "DRIVER",
      createdAt: m.createdAt.toISOString(),
    };
  }

  async list(rideId: string, auth: AuthContext) {
    const { ride } = await this.context(rideId, auth);
    const conv = await this.conversation(ride);
    const rows = await this.prisma.db.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" }, take: 300, include: { attachment: true } });
    return {
      open: this.open(ride),
      otherName: auth.scope === "PASSENGER" ? ride.driver.user.firstName : ride.passenger.user.firstName,
      messages: await Promise.all(rows.map((m) => this.view(m, auth.userId, ride.passenger.userId))),
    };
  }

  async send(rideId: string, auth: AuthContext, body: { clientMessageId: string; body?: string; attachmentId?: string; quickReply?: boolean }) {
    const { ride, role } = await this.context(rideId, auth);
    if (!this.open(ride)) fail("CHAT_CLOSED", "Chat for this trip has closed. Contact support if you need help.");
    const text = body.body?.trim() || null;
    if (!text && !body.attachmentId) fail("VALIDATION_FAILED", "Type a message");
    if (body.attachmentId) {
      const f = await this.prisma.db.fileObject.findUnique({ where: { id: body.attachmentId } });
      if (!f || f.uploaderId !== auth.userId || !f.objectKey.startsWith("chat-image/") || !(await this.storage.head(f.objectKey))) fail("FILE_INVALID", "Upload the photo again");
    }
    const conv = await this.conversation(ride);
    let msg;
    try {
      msg = await this.prisma.db.message.create({
        data: {
          conversationId: conv.id, senderId: auth.userId, clientMessageId: body.clientMessageId, body: text, attachmentId: body.attachmentId,
          type: body.attachmentId ? "IMAGE" : body.quickReply ? "QUICK_REPLY" : "TEXT",
          isFlagged: text ? PHONE.test(text) : false,
        },
        include: { attachment: true },
      });
    } catch (e) {
      // Resend of the same message (flaky network): return the original.
      if (!isUniqueViolation(e)) throw e;
      msg = await this.prisma.db.message.findUniqueOrThrow({ where: { conversationId_clientMessageId: { conversationId: conv.id, clientMessageId: body.clientMessageId } }, include: { attachment: true } });
      return this.view(msg, auth.userId, ride.passenger.userId);
    }
    await this.prisma.db.conversationParticipant.update({ where: { conversationId_userId: { conversationId: conv.id, userId: auth.userId } }, data: { lastReadAt: msg.createdAt, lastReadMessageId: msg.id } });

    const otherId = role === "PASSENGER" ? ride.driver.userId : ride.passenger.userId;
    const senderName = role === "PASSENGER" ? ride.passenger.user.firstName : ride.driver.user.firstName;
    this.events.toUser(otherId, "chat.message", { rideId, message: await this.view(msg, otherId, ride.passenger.userId) });
    this.events.toUser(auth.userId, "chat.message", { rideId, message: await this.view(msg, auth.userId, ride.passenger.userId) });
    this.notify.send(otherId, {
      category: "CHAT", title: senderName || "New message", body: text ?? "Sent a photo", inbox: false, channelId: "chat",
      data: { type: "chat", rideId },
    });
    return this.view(msg, auth.userId, ride.passenger.userId);
  }

  async markRead(rideId: string, auth: AuthContext) {
    const { ride, role } = await this.context(rideId, auth);
    const conv = await this.conversation(ride);
    const last = await this.prisma.db.message.findFirst({ where: { conversationId: conv.id }, orderBy: { createdAt: "desc" } });
    await this.prisma.db.conversationParticipant.update({ where: { conversationId_userId: { conversationId: conv.id, userId: auth.userId } }, data: { lastReadAt: new Date(), lastReadMessageId: last?.id } });
    const otherId = role === "PASSENGER" ? ride.driver.userId : ride.passenger.userId;
    this.events.toUser(otherId, "chat.read", { rideId, readAt: new Date().toISOString() });
    return { ok: true };
  }

  /** Transcript for support and dispute handling. */
  async transcript(rideId: string) {
    const ride = await this.prisma.db.ride.findUnique({ where: { id: rideId }, include: { passenger: true } });
    if (!ride) return [];
    const conv = await this.prisma.db.conversation.findUnique({ where: { rideId } });
    if (!conv) return [];
    const rows = await this.prisma.db.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" }, include: { attachment: true } });
    return Promise.all(rows.map(async (m) => ({ ...(await this.view(m, null, ride.passenger.userId)), flagged: m.isFlagged })));
  }
}
