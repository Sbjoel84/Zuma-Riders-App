import { Injectable, Logger } from "@nestjs/common";
import type { DevicePlatform } from "@zuma/database";
import { env } from "../../config/env";
import { PrismaService } from "../../infra/prisma.service";

export type NotificationCategory = "TRIP" | "PAYMENT" | "SAFETY" | "ACCOUNT" | "CHAT" | "PROMOTIONS";

export interface PushMessage {
  category: NotificationCategory;
  title: string;
  body: string;
  /** Deep-link data for the app, e.g. { type: "ride", rideId }. */
  data?: Record<string, string | number | boolean | null>;
  /** Android notification channel (created by the apps). */
  channelId?: "rides" | "chat" | "default";
  /** Also store in the in-app inbox (default true). Chat messages are not stored. */
  inbox?: boolean;
}

export interface SentPush {
  userId: string;
  to: string[];
  title: string;
  body: string;
  data?: Record<string, unknown>;
  at: Date;
}

/**
 * Push notifications through Expo's push service (which fronts FCM and APNs), plus the in-app inbox.
 * Always called after the business transaction commits; never throws to the caller.
 * `console` (dev/test, refused in production) records messages in `outbox` instead of sending.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger("Push");
  readonly outbox: SentPush[] = [];
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly prisma: PrismaService) {}

  async registerToken(userId: string, token: string, platform: DevicePlatform, installId?: string) {
    const device = installId ? await this.prisma.db.device.findUnique({ where: { userId_installId: { userId, installId } } }) : null;
    // A token belongs to one install; if another account signed in on this phone, it moves to this user.
    await this.prisma.db.pushToken.upsert({
      where: { token },
      update: { userId, platform, deviceId: device?.id ?? null, isActive: true },
      create: { userId, token, platform, deviceId: device?.id ?? null },
    });
  }

  async removeToken(userId: string, token: string) {
    await this.prisma.db.pushToken.updateMany({ where: { userId, token }, data: { isActive: false } });
  }

  /** Fire-and-forget: logs failures, never rejects. */
  send(userId: string, msg: PushMessage): void {
    const p: Promise<void> = this.deliver(userId, msg)
      .catch((e) => this.log.error(`Notification to ${userId} failed: ${(e as Error).message}`))
      .finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
  }

  /** Waits for queued deliveries (tests and graceful shutdown). */
  async flush() {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  /** Awaitable variant (tests, scripts). */
  async deliver(userId: string, msg: PushMessage): Promise<void> {
    const keepInInbox = msg.inbox !== false;
    const row = keepInInbox
      ? await this.prisma.db.notification.create({ data: { userId, channel: "PUSH", templateKey: msg.category, title: msg.title, body: msg.body, data: msg.data ?? undefined } })
      : null;

    if (msg.category !== "SAFETY") {
      const pref = await this.prisma.db.notificationPreference.findUnique({ where: { userId_channel_category: { userId, channel: "PUSH", category: msg.category } } });
      if (pref && !pref.enabled) {
        if (row) await this.prisma.db.notification.update({ where: { id: row.id }, data: { status: "SENT", error: "push disabled by user" } });
        return;
      }
    }

    const tokens = await this.prisma.db.pushToken.findMany({ where: { userId, isActive: true }, select: { token: true } });
    if (!tokens.length) {
      if (row) await this.prisma.db.notification.update({ where: { id: row.id }, data: { status: "FAILED", error: "no registered device" } });
      return;
    }
    const to = tokens.map((t) => t.token);

    if (env().PUSH_PROVIDER === "console") {
      this.outbox.push({ userId, to, title: msg.title, body: msg.body, data: msg.data, at: new Date() });
      if (this.outbox.length > 300) this.outbox.shift();
      if (env().NODE_ENV === "development") this.log.log(`[dev push] ${userId}: ${msg.title} — ${msg.body}`);
      if (row) await this.prisma.db.notification.update({ where: { id: row.id }, data: { status: "SENT", sentAt: new Date() } });
      return;
    }

    const messages = to.map((t) => ({
      to: t, title: msg.title, body: msg.body, data: { ...(msg.data ?? {}), notificationId: row?.id ?? null },
      sound: "default", priority: "high", channelId: msg.channelId ?? "default",
    }));
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(env().EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${env().EXPO_ACCESS_TOKEN}` } : {}) },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: Array<{ status: string; id?: string; message?: string; details?: { error?: string } }> };
    const tickets = json.data ?? [];
    const dead = tickets.map((t, i) => (t.details?.error === "DeviceNotRegistered" ? to[i] : null)).filter(Boolean) as string[];
    if (dead.length) await this.prisma.db.pushToken.updateMany({ where: { token: { in: dead } }, data: { isActive: false } });
    const ok = tickets.some((t) => t.status === "ok");
    if (row) {
      await this.prisma.db.notification.update({
        where: { id: row.id },
        data: ok ? { status: "SENT", sentAt: new Date(), providerRef: tickets.find((t) => t.id)?.id } : { status: "FAILED", error: tickets[0]?.message ?? `Expo ${res.status}` },
      });
    }
  }

  async inbox(userId: string, cursor?: string, limit = 30) {
    const rows = await this.prisma.db.notification.findMany({
      where: { userId }, orderBy: { createdAt: "desc" }, take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    const unread = await this.prisma.db.notification.count({ where: { userId, readAt: null } });
    return {
      unread,
      data: page.map((n) => ({ id: n.id, category: n.templateKey, title: n.title, body: n.body, data: n.data, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() })),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  async markAllRead(userId: string) {
    await this.prisma.db.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  }

  async preferences(userId: string) {
    const rows = await this.prisma.db.notificationPreference.findMany({ where: { userId, channel: "PUSH" } });
    const cats: NotificationCategory[] = ["TRIP", "PAYMENT", "CHAT", "ACCOUNT", "PROMOTIONS"];
    return cats.map((c) => ({ category: c, enabled: rows.find((r) => r.category === c)?.enabled ?? true }));
  }

  async setPreference(userId: string, category: NotificationCategory, enabled: boolean) {
    if (category === "SAFETY") return;
    await this.prisma.db.notificationPreference.upsert({
      where: { userId_channel_category: { userId, channel: "PUSH", category } },
      update: { enabled },
      create: { userId, channel: "PUSH", category, enabled },
    });
  }

  /** Test helper. */
  lastFor(userId: string): SentPush | undefined {
    return [...this.outbox].reverse().find((m) => m.userId === userId);
  }
}
