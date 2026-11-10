import { Injectable } from "@nestjs/common";
import { normalizeNigerianPhone, type AuthTokens, type OtpRequestBody, type OtpVerifyBody } from "@zuma/contracts";
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "crypto";
import { decrypt, sha256, verifyTotp } from "../../infra/crypto";
import { env } from "../../config/env";
import { DomainError, fail } from "../../common/errors";
import type { AuthContext } from "../../common/http";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";
import { SmsService } from "../../infra/sms.service";
import { WalletService } from "../ledger/wallet.service";
import { TokensService } from "./tokens.service";

const OTP_TTL_S = 300;
const OTP_MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly sms: SmsService,
    private readonly tokens: TokensService,
    private readonly wallets: WalletService,
  ) {}

  private hashOtp(otpId: string, code: string) {
    return createHmac("sha256", env().OTP_SECRET).update(`${otpId}:${code}`).digest("hex");
  }

  private async rateLimit(key: string, max: number, windowS: number) {
    const n = await this.redis.client.incr(key);
    if (n === 1) await this.redis.client.expire(key, windowS);
    if (n > max) {
      const ttl = await this.redis.client.ttl(key);
      throw new DomainError("RATE_LIMITED", `Too many attempts. Try again in ${Math.ceil(ttl / 60)} minute(s).`, { retryAfterS: ttl });
    }
  }

  async requestOtp(body: OtpRequestBody, ip: string) {
    const phone = normalizeNigerianPhone(body.phone) ?? fail("VALIDATION_FAILED", "Enter a valid phone number, e.g. 0803 123 4567");
    await this.rateLimit(`rl:otp:phone:${phone}`, env().OTP_LIMIT_PER_PHONE_10MIN, 600);
    await this.rateLimit(`rl:otp:ip:${ip}`, env().OTP_LIMIT_PER_IP_HOUR, 3600);

    if (body.appScope === "ADMIN") {
      const admin = await this.prisma.db.user.findFirst({ where: { phoneE164: phone, adminProfile: { isNot: null } } });
      // Same response either way, so the endpoint can't be used to discover admin numbers.
      if (!admin) return { otpId: randomUUID(), expiresAt: new Date(Date.now() + OTP_TTL_S * 1000).toISOString(), resendAfterS: 60 };
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const id = randomUUID();
    const user = await this.prisma.db.user.findUnique({ where: { phoneE164: phone }, select: { id: true } });
    const sent = await this.sms.send(phone, `Your Zuma code is ${code}. It expires in 5 minutes. Never share it with anyone.`);
    await this.prisma.db.otpVerification.create({
      data: {
        id, userId: user?.id, phoneE164: phone, purpose: user ? "LOGIN" : "SIGNUP", codeHash: this.hashOtp(id, code),
        maxAttempts: OTP_MAX_ATTEMPTS, provider: sent.provider, providerRef: sent.providerRef,
        expiresAt: new Date(Date.now() + OTP_TTL_S * 1000), ipAddress: ip,
      },
    });
    return { otpId: id, expiresAt: new Date(Date.now() + OTP_TTL_S * 1000).toISOString(), resendAfterS: 60, appScope: body.appScope };
  }

  async verifyOtp(body: OtpVerifyBody & { appScope: AuthContext["scope"] }, ip: string, userAgent?: string): Promise<(AuthTokens & { isNewUser: boolean }) | { mfaRequired: true; mfaToken: string }> {
    const otp = await this.prisma.db.otpVerification.findUnique({ where: { id: body.otpId } });
    if (!otp || otp.consumedAt) fail("OTP_INVALID", "That code is not valid. Request a new one.");
    if (otp!.expiresAt < new Date()) fail("OTP_EXPIRED", "That code has expired. Request a new one.");
    if (otp!.attempts >= otp!.maxAttempts) fail("OTP_ATTEMPTS_EXCEEDED", "Too many wrong codes. Request a new one.");

    const expected = Buffer.from(otp!.codeHash, "hex");
    const actual = Buffer.from(this.hashOtp(otp!.id, body.code), "hex");
    if (!timingSafeEqual(expected, actual)) {
      await this.prisma.db.otpVerification.update({ where: { id: otp!.id }, data: { attempts: { increment: 1 } } });
      fail("OTP_INVALID", "That code is not correct.");
    }
    // Atomic consume: a code can be used once even under concurrent verifies.
    const consumed = await this.prisma.db.otpVerification.updateMany({ where: { id: otp!.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (consumed.count === 0) fail("OTP_INVALID", "That code was already used.");

    const phone = otp!.phoneE164;
    let user = await this.prisma.db.user.findUnique({ where: { phoneE164: phone }, include: { roles: { include: { role: true } }, adminProfile: true } });
    const isNewUser = !user;
    if (!user) {
      user = await this.prisma.db.user.create({
        data: { phoneE164: phone, phoneVerifiedAt: new Date(), firstName: "", lastName: "", status: "ACTIVE", referralCode: await this.uniqueReferralCode() },
        include: { roles: { include: { role: true } }, adminProfile: true },
      });
    }
    if (user.status === "SUSPENDED" || user.status === "BLACKLISTED" || user.status === "CLOSED") {
      fail("FORBIDDEN", "This account is not active. Contact support.");
    }

    const scope = body.appScope;
    if (scope === "ADMIN" && !user.adminProfile) fail("FORBIDDEN", "This number does not have admin access");
    if (scope === "PASSENGER") await this.ensurePassenger(user.id);
    if (scope === "DRIVER") await this.ensureRole(user.id, "driver");

    const device = await this.prisma.db.device.upsert({
      where: { userId_installId: { userId: user.id, installId: body.device.installId } },
      update: { lastSeenAt: new Date(), appVersion: body.device.appVersion, model: body.device.model },
      create: { userId: user.id, installId: body.device.installId, platform: body.device.platform, model: body.device.model, appVersion: body.device.appVersion, lastSeenAt: new Date() },
    });
    // Admins with an authenticator app: the SMS code is only the first factor.
    if (scope === "ADMIN" && user.adminProfile?.totpEnabledAt) {
      const mfaToken = randomBytes(24).toString("base64url");
      await this.redis.client.set(`mfa:ticket:${mfaToken}`, JSON.stringify({ userId: user.id, deviceId: device.id }), "EX", 300);
      return { mfaRequired: true, mfaToken };
    }
    await this.prisma.db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const tokens = await this.issue(user.id, scope, device.id, randomUUID(), null, ip, userAgent);
    return { ...tokens, isNewUser };
  }

  /** Second sign-in step for admins: a 6-digit authenticator code or a one-time recovery code. */
  async verifyMfa(mfaToken: string, code: string, ip: string, userAgent?: string): Promise<AuthTokens & { isNewUser: false; usedRecoveryCode: boolean }> {
    const raw = await this.redis.client.get(`mfa:ticket:${mfaToken}`);
    if (!raw) fail("MFA_INVALID", "Your sign-in expired. Start again with your phone number.");
    const attempts = await this.redis.client.incr(`mfa:attempts:${mfaToken}`);
    await this.redis.client.expire(`mfa:attempts:${mfaToken}`, 300);
    if (attempts > 5) {
      await this.redis.client.del(`mfa:ticket:${mfaToken}`);
      fail("OTP_ATTEMPTS_EXCEEDED", "Too many wrong codes. Start again.");
    }
    const { userId, deviceId } = JSON.parse(raw!) as { userId: string; deviceId: string };
    const admin = await this.prisma.db.adminProfile.findUnique({ where: { userId } });
    if (!admin?.totpSecretEnc || !admin.totpEnabledAt) fail("MFA_INVALID", "Two-factor is not set up for this account");
    const clean = code.replace(/\s/g, "");
    let usedRecoveryCode = false;
    if (/^\d{6}$/.test(clean)) {
      const step = verifyTotp(decrypt(admin!.totpSecretEnc!), clean);
      if (step === null) fail("MFA_INVALID", "That code is not correct. Check your authenticator app.");
      // Each code works once, even within its 30-second window.
      const fresh = await this.redis.client.set(`mfa:used:${userId}:${step}`, "1", "EX", 120, "NX");
      if (!fresh) fail("MFA_INVALID", "That code was already used. Wait for the next one.");
    } else {
      const h = sha256(clean.toUpperCase());
      if (!admin!.recoveryCodesHash.includes(h)) fail("MFA_INVALID", "That recovery code is not valid");
      await this.prisma.db.adminProfile.update({ where: { userId }, data: { recoveryCodesHash: admin!.recoveryCodesHash.filter((x) => x !== h) } });
      usedRecoveryCode = true;
    }
    await this.redis.client.del(`mfa:ticket:${mfaToken}`, `mfa:attempts:${mfaToken}`);
    await this.prisma.db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    const tokens = await this.issue(userId, "ADMIN", deviceId, randomUUID(), null, ip, userAgent);
    return { ...tokens, isNewUser: false, usedRecoveryCode };
  }

  private async issue(userId: string, scope: AuthContext["scope"], deviceId: string | null, familyId: string, parentId: string | null, ip?: string, ua?: string): Promise<AuthTokens> {
    const refresh = this.tokens.newRefreshToken();
    const session = await this.prisma.db.userSession.create({
      data: {
        userId, deviceId, familyId, parentSessionId: parentId, scope, refreshTokenHash: refresh.hash,
        ipAddress: ip, userAgent: ua?.slice(0, 300),
        expiresAt: new Date(Date.now() + env().REFRESH_TOKEN_TTL_DAYS * 86400_000),
      },
    });
    const roles = await this.prisma.db.userRole.findMany({ where: { userId }, include: { role: true } });
    const accessToken = await this.tokens.signAccess({ userId, scope, sessionId: session.id, roles: roles.map((r) => r.role.key) });
    return { accessToken, refreshToken: refresh.token, expiresIn: env().ACCESS_TOKEN_TTL_S };
  }

  async refresh(refreshToken: string, ip?: string, ua?: string): Promise<AuthTokens> {
    const session = await this.prisma.db.userSession.findUnique({ where: { refreshTokenHash: this.tokens.hashRefresh(refreshToken) } });
    if (!session) fail("UNAUTHENTICATED", "Sign in again");
    if (session!.revokedAt) {
      // Reuse of a rotated token: someone else may hold it. Kill the whole family.
      await this.revokeFamily(session!.familyId, "refresh_token_reuse");
      fail("TOKEN_REUSED", "For your security, you were signed out. Sign in again.");
    }
    if (session!.expiresAt < new Date()) fail("UNAUTHENTICATED", "Your session expired. Sign in again.");
    const rotated = await this.prisma.db.userSession.updateMany({
      where: { id: session!.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "rotated", lastUsedAt: new Date() },
    });
    if (rotated.count === 0) {
      await this.revokeFamily(session!.familyId, "refresh_token_race");
      fail("TOKEN_REUSED", "For your security, you were signed out. Sign in again.");
    }
    return this.issue(session!.userId, session!.scope, session!.deviceId, session!.familyId, session!.id, ip, ua);
  }

  async logout(sessionId: string) {
    const s = await this.prisma.db.userSession.findUnique({ where: { id: sessionId } });
    if (s) await this.revokeFamily(s.familyId, "logout");
    await this.markRevoked([sessionId]);
  }

  async logoutAll(userId: string) {
    const sessions = await this.prisma.db.userSession.findMany({ where: { userId }, select: { id: true } });
    await this.prisma.db.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "logout_all" } });
    await this.markRevoked(sessions.map((s) => s.id));
  }

  private async revokeFamily(familyId: string, reason: string) {
    const sessions = await this.prisma.db.userSession.findMany({ where: { familyId }, select: { id: true } });
    await this.prisma.db.userSession.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    await this.markRevoked(sessions.map((s) => s.id));
  }

  /** Access tokens carry the session id; the guard rejects revoked ones until they would have expired anyway. */
  private async markRevoked(ids: string[]) {
    if (!ids.length) return;
    const ttl = env().ACCESS_TOKEN_TTL_S + 60;
    const pipe = this.redis.client.pipeline();
    ids.forEach((id) => pipe.set(`sess:revoked:${id}`, "1", "EX", ttl));
    await pipe.exec();
  }

  private async ensureRole(userId: string, key: string) {
    const role = await this.prisma.db.role.findUniqueOrThrow({ where: { key } });
    await this.prisma.db.userRole.upsert({ where: { userId_roleId: { userId, roleId: role.id } }, update: {}, create: { userId, roleId: role.id } });
  }

  private async ensurePassenger(userId: string) {
    await this.ensureRole(userId, "passenger");
    await this.prisma.db.passengerProfile.upsert({ where: { userId }, update: {}, create: { userId } });
    await this.wallets.ensureWallet(userId, "PASSENGER");
  }

  private async uniqueReferralCode(): Promise<string> {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let i = 0; i < 10; i++) {
      let code = "ZU";
      for (let j = 0; j < 6; j++) code += alphabet[randomInt(alphabet.length)];
      if (!(await this.prisma.db.user.findUnique({ where: { referralCode: code } }))) return code;
    }
    throw new Error("Could not allocate referral code");
  }
}
