import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { createPrismaClient, PrismaClient } from "@zuma/database";
import { env } from "../config/env";

/** Thin injectable wrapper so services depend on `PrismaService` and tests can swap the URL via env. */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly db: PrismaClient;

  constructor() {
    this.db = createPrismaClient({ connectionString: env().DATABASE_URL, quiet: env().NODE_ENV !== "development" });
  }

  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}

export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Postgres unique violation surfaced by Prisma. */
export function isUniqueViolation(e: unknown, constraintHint?: string): boolean {
  const err = e as { code?: string; meta?: { target?: unknown; constraint?: unknown; driverAdapterError?: { cause?: { constraint?: unknown } } }; message?: string };
  if (err?.code !== "P2002" && !(err?.message ?? "").includes("23505")) return false;
  if (!constraintHint) return true;
  const blob = JSON.stringify(err.meta ?? {}) + (err.message ?? "");
  return blob.includes(constraintHint);
}
