import { execSync } from "child_process";
import path from "path";
import { Client } from "pg";
import Redis from "ioredis";

/** Wipes the test database (keeping schema) and re-seeds reference data, then flushes Redis db 1. */
export default async function globalSetup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://zuma:zuma@localhost:5432/zuma_test";
  const pg = new Client({ connectionString: url });
  await pg.connect();
  const { rows } = await pg.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('spatial_ref_sys','_prisma_migrations')`);
  // Append-only triggers block DELETE but not TRUNCATE.
  await pg.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await pg.end();
  execSync("npx tsx prisma/seed.ts", {
    cwd: path.resolve(__dirname, "../../../packages/database"),
    env: { ...process.env, DATABASE_URL: url, SEED_ADMIN_PHONE: "+2348000000001" },
    stdio: "pipe",
  });
  const redis = new Redis(process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1");
  await redis.flushdb();
  await redis.quit();
}
