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
