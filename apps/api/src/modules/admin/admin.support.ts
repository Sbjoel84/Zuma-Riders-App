import { Injectable } from "@nestjs/common";
import { fail } from "../../common/errors";
import type { AuthContext } from "../../common/http";
import { PrismaService, type Tx } from "../../infra/prisma.service";

/** Lagos is UTC+1 with no daylight saving. */
const LAGOS_OFFSET_MS = 3600_000;

export function lagosDayStart(daysAgo = 0, now = new Date()): Date {
  const local = new Date(now.getTime() + LAGOS_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  local.setUTCDate(local.getUTCDate() - daysAgo);
  return new Date(local.getTime() - LAGOS_OFFSET_MS);
}

export function lagosHour(d: Date): number {
  return new Date(d.getTime() + LAGOS_OFFSET_MS).getUTCHours();
}

/** JSON-safe copy (BigInt → string) for audit snapshots. */
export function snapshot<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

export function pageArgs(cursor?: string, limit?: string) {
  const take = Math.min(100, Math.max(1, parseInt(limit ?? "50", 10) || 50));
  return { take: take + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), _take: take };
}

export function page<T extends { id: string }>(rows: T[], take: number) {
  const data = rows.slice(0, take);
  return { data, nextCursor: rows.length > take ? data[data.length - 1]!.id : null };
}

/** Admin identity and the two audit trails: AdminActionLog (what an admin did) and AuditLog (what changed). */
@Injectable()
export class AdminContext {
  constructor(private readonly prisma: PrismaService) {}

  async adminId(auth: AuthContext): Promise<string> {
    const a = await this.prisma.db.adminProfile.findUnique({ where: { userId: auth.userId } });
    return a?.id ?? fail("FORBIDDEN", "Admin profile missing");
  }

  async action(adminId: string, action: string, targetType: string, targetId: string, reason?: string, tx?: Tx) {
    await (tx ?? this.prisma.db).adminActionLog.create({ data: { adminId, action, targetType, targetId, reason } });
  }

  async audit(adminId: string, entity: string, entityId: string, operation: "CREATE" | "UPDATE" | "DELETE", before: unknown, after: unknown, tx?: Tx) {
    await (tx ?? this.prisma.db).auditLog.create({
      data: { adminId, actorType: "ADMIN", entity, entityId, operation, before: before === null ? undefined : (snapshot(before) as object), after: after === null ? undefined : (snapshot(after) as object) },
    });
  }
}
