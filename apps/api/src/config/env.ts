import "dotenv/config";
import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().default("redis://localhost:6379"),

    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    OTP_SECRET: z.string().min(32),
    TRIP_PIN_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL_S: z.coerce.number().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),

    SMS_PROVIDER: z.enum(["console", "termii"]).default("console"),
    TERMII_API_KEY: z.string().optional(),
    TERMII_SENDER_ID: z.string().default("Zuma"),

    MAPS_PROVIDER: z.enum(["google", "estimate"]).default("estimate"),
    GOOGLE_MAPS_API_KEY: z.string().optional(),

    WORKER_ENABLED: z
      .string()
      .default("true")
      .transform((v) => v === "true"),
    MATCH_EXPAND_AFTER_S: z.coerce.number().default(15),
    EARNINGS_HOLD_S: z.coerce.number().default(86400),
    DRIVER_HEARTBEAT_TTL_S: z.coerce.number().default(45),
    DRIVER_NEGATIVE_LIMIT_KOBO: z.coerce.bigint().default(500000n),
    ARRIVAL_RADIUS_M: z.coerce.number().default(300),
    CORS_ORIGINS: z.string().default("*"),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === "production") {
      if (e.SMS_PROVIDER === "console") ctx.addIssue({ code: "custom", path: ["SMS_PROVIDER"], message: "console SMS is not allowed in production" });
      if (e.MAPS_PROVIDER === "estimate") ctx.addIssue({ code: "custom", path: ["MAPS_PROVIDER"], message: "estimated routing is not allowed in production; use google" });
    }
    if (e.SMS_PROVIDER === "termii" && !e.TERMII_API_KEY) ctx.addIssue({ code: "custom", path: ["TERMII_API_KEY"], message: "required for termii" });
    if (e.MAPS_PROVIDER === "google" && !e.GOOGLE_MAPS_API_KEY) ctx.addIssue({ code: "custom", path: ["GOOGLE_MAPS_API_KEY"], message: "required for google maps" });
  });

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error("Invalid environment configuration:\n" + msg);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Tests override env between suites. */
export function resetEnvCache() {
  cached = null;
}
