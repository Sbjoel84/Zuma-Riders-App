import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma 7: connection URLs live here, not in schema.prisma.
// DIRECT_DATABASE_URL = Neon direct (non-pooled) connection, used by Migrate.
// DATABASE_URL        = Neon pooled connection, used by the app via @prisma/adapter-pg.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DIRECT_DATABASE_URL"),
  },
});
