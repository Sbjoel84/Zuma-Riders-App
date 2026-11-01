import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client/client";

export * from "./generated/client/client";

export interface CreatePrismaOptions {
  connectionString: string;
  log?: boolean;
}

/**
 * Prisma 7 uses a driver adapter at runtime. Pass the POOLED connection string
 * (Neon "-pooler" host) here; migrations use DIRECT_DATABASE_URL via prisma.config.ts.
 */
export function createPrismaClient(opts: CreatePrismaOptions): PrismaClient {
  const adapter = new PrismaPg({ connectionString: opts.connectionString });
  return new PrismaClient({
    adapter,
    log: opts.log ? ["query", "warn", "error"] : ["warn", "error"],
  });
}
