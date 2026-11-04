import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import type { Prisma, TicketStatus } from "@zuma/database";
import { z } from "zod";
import { fail } from "../../common/errors";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { isUniqueViolation, PrismaService } from "../../infra/prisma.service";
import { RequirePermission, Scopes } from "../auth/auth.guard";
import { AdminContext } from "../admin/admin.support";
import { EventsService } from "../realtime/events.service";
import { shortCode } from "../rides/codes";

const CATEGORIES = ["PASSENGER_COMPLAINT", "DRIVER_COMPLAINT", "TRIP_ISSUE", "LOST_PROPERTY", "PAYMENT", "ACCOUNT", "SAFETY", "OTHER"] as const;

const CreateTicket = z.object({
  category: z.enum(CATEGORIES),
  subject: z.string().trim().min(3).max(120),
  body: z.string().trim().min(3).max(2000),
  rideId: z.string().optional(),
});
const MessageBody = z.object({ body: z.string().trim().min(1).max(2000) });
const AdminMessage = z.object({ body: z.string().trim().min(1).max(2000), internal: z.boolean().default(false) });
const StatusBody = z.object({ status: z.enum(["OPEN", "ASSIGNED", "AWAITING_USER", "RESOLVED", "CLOSED"]), resolution: z.string().trim().max(500).optional() });

const name = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();
const PRIORITY: Record<string, "LOW" | "NORMAL" | "HIGH" | "URGENT"> = { SAFETY: "URGENT", PAYMENT: "HIGH", TRIP_ISSUE: "HIGH", LOST_PROPERTY: "NORMAL" };

/** Passenger and driver side: report a problem, follow the conversation. */
@Scopes("PASSENGER", "DRIVER")
@Controller("v1/support")
export class SupportController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  @Post("tickets")
  async create(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateTicket)) body: z.infer<typeof CreateTicket>) {
    let cityId: string | null = null;
    if (body.rideId) {
      const ride = await this.prisma.db.ride.findUnique({ where: { id: body.rideId }, include: { passenger: true, driver: true, rideRequest: true } });
      if (!ride || (ride.passenger.userId !== auth.userId && ride.driver.userId !== auth.userId)) fail("NOT_FOUND", "Trip not found");
      cityId = ride!.rideRequest.cityId;
    }
    for (let i = 0; ; i++) {
      try {
        const t = await this.prisma.db.supportTicket.create({
          data: {
            number: shortCode("T"), requesterId: auth.userId, rideId: body.rideId, category: body.category, subject: body.subject,
            priority: PRIORITY[body.category] ?? "NORMAL",
            messages: { create: { authorId: auth.userId, body: body.body } },
          },
        });
        const city = cityId ?? (await this.prisma.db.city.findFirst({ where: { isLive: true } }))?.id;
        if (city) this.events.toAdmins(city, "admin.support.ticket", { id: t.id, number: t.number, priority: t.priority });
        return { id: t.id, number: t.number, status: t.status };
      } catch (e) {
        if (isUniqueViolation(e, "number") && i < 3) continue;
        throw e;
      }
    }
  }

  @Get("tickets")
  async mine(@Auth() auth: AuthContext) {
    const rows = await this.prisma.db.supportTicket.findMany({ where: { requesterId: auth.userId }, orderBy: { createdAt: "desc" }, take: 30 });
    return rows.map((t) => ({ id: t.id, number: t.number, subject: t.subject, category: t.category, status: t.status, createdAt: t.createdAt.toISOString() }));
  }

  @Get("tickets/:id")
  async one(@Auth() auth: AuthContext, @Param("id") id: string) {
    const t = await this.prisma.db.supportTicket.findUnique({ where: { id }, include: { messages: { where: { isInternal: false }, orderBy: { createdAt: "asc" }, include: { author: true } } } });
    if (!t || t.requesterId !== auth.userId) fail("NOT_FOUND", "Ticket not found");
    return {
      id: t!.id, number: t!.number, subject: t!.subject, status: t!.status,
      messages: t!.messages.map((m) => ({ id: m.id, fromSupport: m.authorId !== auth.userId, author: m.authorId === auth.userId ? "You" : "Zuma Support", body: m.body, at: m.createdAt.toISOString() })),
    };
  }

  @Post("tickets/:id/messages")
  async reply(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(MessageBody)) body: { body: string }) {
    const t = await this.prisma.db.supportTicket.findUnique({ where: { id } });
    if (!t || t.requesterId !== auth.userId) fail("NOT_FOUND", "Ticket not found");
    await this.prisma.db.$transaction([
      this.prisma.db.supportMessage.create({ data: { ticketId: id, authorId: auth.userId, body: body.body } }),
      this.prisma.db.supportTicket.update({ where: { id }, data: { status: t!.assigneeId ? "ASSIGNED" : "OPEN" } }),
    ]);
    return { ok: true };
  }
}

/** Support desk for the operations team. */
@Controller("v1/admin/support")
export class AdminSupportController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminContext,
  ) {}

  @RequirePermission("support:write")
  @Get("tickets")
  async list(@Query("status") status?: string, @Query("mine") mine?: string, @Auth() auth?: AuthContext) {
    const where: Prisma.SupportTicketWhereInput = {};
    if (status === "open") where.status = { in: ["OPEN", "ASSIGNED"] };
    else if (status) where.status = status as TicketStatus;
    if (mine === "1" && auth) where.assigneeId = await this.admin.adminId(auth);
    const rows = await this.prisma.db.supportTicket.findMany({
      where, take: 100,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      include: { requester: { include: { driver: true } }, assignee: { include: { user: true } }, ride: true, _count: { select: { messages: true } } },
    });
    const counts = await this.prisma.db.supportTicket.groupBy({ by: ["status"], _count: true });
    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
      data: rows.map((t) => ({
        id: t.id, number: t.number, subject: t.subject, category: t.category, priority: t.priority, status: t.status,
        requester: name(t.requester), requesterRole: t.requester.driver ? "Driver" : "Passenger", rideCode: t.ride?.code ?? null,
        assignee: t.assignee ? name(t.assignee.user) : null, messages: t._count.messages, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(),
      })),
    };
  }

  @RequirePermission("support:write")
  @Get("tickets/:id")
  async one(@Param("id") id: string) {
    const t = await this.prisma.db.supportTicket.findUnique({
      where: { id },
      include: { requester: true, assignee: { include: { user: true } }, ride: true, messages: { orderBy: { createdAt: "asc" }, include: { author: { include: { adminProfile: true } } } } },
    });
    if (!t) fail("NOT_FOUND", "Ticket not found");
    return {
      id: t!.id, number: t!.number, subject: t!.subject, category: t!.category, priority: t!.priority, status: t!.status, resolution: t!.resolution,
      requester: { id: t!.requester.id, name: name(t!.requester), phone: t!.requester.phoneE164 },
      ride: t!.ride ? { id: t!.ride.id, code: t!.ride.code, status: t!.ride.status } : null,
      assignee: t!.assignee ? { id: t!.assignee.id, name: name(t!.assignee.user) } : null,
      messages: t!.messages.map((m) => ({ id: m.id, author: name(m.author), fromStaff: !!m.author.adminProfile, internal: m.isInternal, body: m.body, at: m.createdAt.toISOString() })),
    };
  }

  @RequirePermission("support:write")
  @Post("tickets/:id/messages")
  async message(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(AdminMessage)) body: { body: string; internal: boolean }) {
    const adminId = await this.admin.adminId(auth);
    const t = await this.prisma.db.supportTicket.findUnique({ where: { id } });
    if (!t) fail("NOT_FOUND", "Ticket not found");
    await this.prisma.db.$transaction(async (tx) => {
      await tx.supportMessage.create({ data: { ticketId: id, authorId: auth.userId, body: body.body, isInternal: body.internal } });
      if (!body.internal) await tx.supportTicket.update({ where: { id }, data: { status: "AWAITING_USER", assigneeId: t!.assigneeId ?? adminId } });
    });
    return { ok: true };
  }

  @RequirePermission("support:write")
  @Post("tickets/:id/assign")
  @HttpCode(200)
  async assign(@Auth() auth: AuthContext, @Param("id") id: string, @Body() body: { unassign?: boolean }) {
    const adminId = await this.admin.adminId(auth);
    await this.prisma.db.supportTicket.update({ where: { id }, data: body?.unassign ? { assigneeId: null, status: "OPEN" } : { assigneeId: adminId, status: "ASSIGNED" } });
    await this.admin.action(adminId, body?.unassign ? "tickets.unassign" : "tickets.assign", "SupportTicket", id);
    return { ok: true };
  }

  @RequirePermission("support:write")
  @Post("tickets/:id/status")
  @HttpCode(200)
  async status(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(StatusBody)) body: z.infer<typeof StatusBody>) {
    const adminId = await this.admin.adminId(auth);
    const done = body.status === "RESOLVED" || body.status === "CLOSED";
    await this.prisma.db.supportTicket.update({ where: { id }, data: { status: body.status, resolution: body.resolution, resolvedAt: done ? new Date() : null } });
    await this.admin.action(adminId, `tickets.${body.status.toLowerCase()}`, "SupportTicket", id, body.resolution);
    return { ok: true };
  }
}
