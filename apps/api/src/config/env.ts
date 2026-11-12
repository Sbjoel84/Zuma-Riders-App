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
    TERMII_SENDER_ID: z.string().default("RidersApp"),

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
    OTP_LIMIT_PER_PHONE_10MIN: z.coerce.number().default(3),
    OTP_LIMIT_PER_IP_HOUR: z.coerce.number().default(20),

    /** Public base URL of this API (used for fake checkout, local uploads and trip-share links). */
    PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
    /** 64 hex chars (32 bytes) for AES-256-GCM of card tokens and 2FA secrets. Derived from JWT_SECRET outside production. */
    DATA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "must be 64 hex characters").optional(),

    PAYMENTS_PROVIDER: z.enum(["paystack", "fake"]).default("fake"),
    PAYSTACK_SECRET_KEY: z.string().optional(),
    /** Paystack needs an email on every charge; riders without one get <phone>@<this domain>. */
    PAYMENT_EMAIL_DOMAIN: z.string().default("riders.zuma.ng"),
    /** Fake provider only: deliver webhooks automatically after checkout/transfers (off in tests). */
    FAKE_PAYMENTS_AUTO_WEBHOOK: z.string().default("true").transform((v) => v === "true"),
    TOPUP_MIN_KOBO: z.coerce.bigint().default(10000n),
    TOPUP_MAX_KOBO: z.coerce.bigint().default(50000000n),
    /** Withdrawals at or below this are approved and sent automatically (0 = always need finance approval). */
    PAYOUT_AUTO_APPROVE_MAX_KOBO: z.coerce.bigint().default(0n),

    STORAGE_PROVIDER: z.enum(["s3", "local"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default(".uploads"),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default("auto"),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    DRIVER_DOCS_REQUIRED: z.string().default("true").transform((v) => v === "true"),

    PUSH_PROVIDER: z.enum(["expo", "console"]).default("console"),
    EXPO_ACCESS_TOKEN: z.string().optional(),
    CHAT_OPEN_AFTER_TRIP_S: z.coerce.number().default(3600),

    REFERRAL_REWARD_PASSENGER_KOBO: z.coerce.bigint().default(50000n),
    REFERRAL_REWARD_DRIVER_KOBO: z.coerce.bigint().default(200000n),
    REFERRAL_DRIVER_TRIPS: z.coerce.number().default(10),

    /** Admins must use an authenticator app. Defaults to on in production. */
    ADMIN_2FA_REQUIRED: z.enum(["true", "false"]).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === "production") {
      if (e.SMS_PROVIDER === "console") ctx.addIssue({ code: "custom", path: ["SMS_PROVIDER"], message: "console SMS is not allowed in production" });
      if (e.MAPS_PROVIDER === "estimate") ctx.addIssue({ code: "custom", path: ["MAPS_PROVIDER"], message: "estimated routing is not allowed in production; use google" });
      if (e.PAYMENTS_PROVIDER === "fake") ctx.addIssue({ code: "custom", path: ["PAYMENTS_PROVIDER"], message: "fake payments are not allowed in production; use paystack" });
      if (e.STORAGE_PROVIDER === "local") ctx.addIssue({ code: "custom", path: ["STORAGE_PROVIDER"], message: "local file storage is not allowed in production; use s3" });
      if (e.PUSH_PROVIDER === "console") ctx.addIssue({ code: "custom", path: ["PUSH_PROVIDER"], message: "console push is not allowed in production; use expo" });
      if (!e.DATA_ENCRYPTION_KEY) ctx.addIssue({ code: "custom", path: ["DATA_ENCRYPTION_KEY"], message: "required in production: openssl rand -hex 32" });
    }
    if (e.PAYMENTS_PROVIDER === "paystack" && !e.PAYSTACK_SECRET_KEY) ctx.addIssue({ code: "custom", path: ["PAYSTACK_SECRET_KEY"], message: "required for paystack" });
    if (e.STORAGE_PROVIDER === "s3") {
      for (const k of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
        if (!e[k]) ctx.addIssue({ code: "custom", path: [k], message: "required for s3 storage" });
      }
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

export function admin2faRequired(): boolean {
  const e = env();
  return e.ADMIN_2FA_REQUIRED ? e.ADMIN_2FA_REQUIRED === "true" : e.NODE_ENV === "production";
}

/** Tests override env between suites. */
export function resetEnvCache() {
  cached = null;
}
