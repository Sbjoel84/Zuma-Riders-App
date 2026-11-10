// Loaded before every test file (jest setupFiles). Points the app at the test database and Redis db 1.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://zuma:zuma@localhost:5432/zuma_test";
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1";
process.env.JWT_SECRET = "test-jwt-secret-test-jwt-secret-test-jwt-secret";
process.env.OTP_SECRET = "test-otp-secret-test-otp-secret-test-otp-secret";
process.env.TRIP_PIN_SECRET = "test-pin-secret-test-pin-secret-test-pin-secret";
process.env.SMS_PROVIDER = "console";
process.env.MAPS_PROVIDER = "estimate";
process.env.WORKER_ENABLED = "true";
process.env.MATCH_EXPAND_AFTER_S = "1";
process.env.EARNINGS_HOLD_S = "1";
process.env.OTP_LIMIT_PER_IP_HOUR = "1000";
process.env.OTP_LIMIT_PER_PHONE_10MIN = "20";
process.env.PAYMENTS_PROVIDER = "fake";
process.env.FAKE_PAYMENTS_AUTO_WEBHOOK = "false";
process.env.PUSH_PROVIDER = "console";
process.env.STORAGE_PROVIDER = "local";
process.env.STORAGE_LOCAL_DIR = require("path").join(require("os").tmpdir(), "zuma-test-uploads");
// Most suites approve drivers without uploading documents; documents.e2e turns this on.
process.env.DRIVER_DOCS_REQUIRED = "false";
process.env.ADMIN_2FA_REQUIRED = "false";
process.env.PUBLIC_API_URL = "http://127.0.0.1:4000";
