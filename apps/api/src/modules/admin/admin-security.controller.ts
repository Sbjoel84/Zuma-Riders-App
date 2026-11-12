import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { randomBytes } from "crypto";
import { z } from "zod";
import { fail } from "../../common/errors";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { admin2faRequired } from "../../config/env";
import { base32Encode, decrypt, encrypt, sha256, verifyTotp } from "../../infra/crypto";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";
import { Scopes } from "../auth/auth.guard";
import { AdminContext } from "./admin.support";

const CodeBody = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your app") });

function recoveryCodes(): { plain: string[]; hashes: string[] } {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const plain = Array.from({ length: 10 }, () => {
    const b = randomBytes(8);
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
  return { plain, hashes: plain.map((p) => sha256(p)) };
}

/**
 * The signed-in admin's own two-factor settings. Scoped to ADMIN tokens but not permission-gated, so an
 * admin who must enrol (ADMIN_2FA_REQUIRED) can still reach these routes.
 */
@Scopes("ADMIN")
@Controller("v1/admin/me")
export class AdminSecurityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly admin: AdminContext,
  ) {}

  private async profile(auth: AuthContext) {
    const a = await this.prisma.db.adminProfile.findUnique({ where: { userId: auth.userId }, include: { user: true } });
    if (!a) fail("FORBIDDEN", "Admin profile missing");
    return a!;
  }

  private async forget(userId: string) {
    await this.redis.client.del(`mfa:enabled:${userId}`);
  }

  @Get("security")
  async status(@Auth() auth: AuthContext) {
    const a = await this.profile(auth);
    return { totpEnabled: Boolean(a.totpEnabledAt), enabledAt: a.totpEnabledAt?.toISOString() ?? null, required: admin2faRequired(), recoveryCodesLeft: a.recoveryCodesHash.length, name: `${a.user.firstName} ${a.user.lastName}`.trim(), phone: a.user.phoneE164 };
  }

  /** Step 1: a new secret for the authenticator app. Not active until confirmed with a code. */
  @Post("2fa/setup")
  @HttpCode(200)
  async setup(@Auth() auth: AuthContext) {
    const a = await this.profile(auth);
    if (a.totpEnabledAt) fail("VALIDATION_FAILED", "Two-factor is already on. Turn it off first to move to a new phone.");
    const secret = base32Encode(randomBytes(20));
    await this.prisma.db.adminProfile.update({ where: { id: a.id }, data: { totpSecretEnc: encrypt(secret) } });
    const label = encodeURIComponent(`Riders App Admin:${a.user.phoneE164}`);
    return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("Riders App Admin")}&algorithm=SHA1&digits=6&period=30` };
  }

  /** Step 2: confirm with a code; returns one-time recovery codes (shown once). */
  @Post("2fa/enable")
  @HttpCode(200)
  async enable(@Auth() auth: AuthContext, @Body(new ZodPipe(CodeBody)) body: { code: string }) {
    const a = await this.profile(auth);
    if (a.totpEnabledAt) fail("VALIDATION_FAILED", "Two-factor is already on");
    if (!a.totpSecretEnc) fail("VALIDATION_FAILED", "Start the setup first");
    if (verifyTotp(decrypt(a.totpSecretEnc!), body.code) === null) fail("MFA_INVALID", "That code is not correct. Check the time on your phone and try the newest code.");
    const codes = recoveryCodes();
    await this.prisma.db.adminProfile.update({ where: { id: a.id }, data: { totpEnabledAt: new Date(), recoveryCodesHash: codes.hashes } });
    await this.forget(auth.userId);
    await this.admin.action(a.id, "security.2fa_enabled", "AdminProfile", a.id);
    return { enabled: true, recoveryCodes: codes.plain };
  }

  @Post("2fa/recovery-codes")
  @HttpCode(200)
  async regenerate(@Auth() auth: AuthContext, @Body(new ZodPipe(CodeBody)) body: { code: string }) {
    const a = await this.profile(auth);
    if (!a.totpEnabledAt || !a.totpSecretEnc) fail("VALIDATION_FAILED", "Turn on two-factor first");
    if (verifyTotp(decrypt(a.totpSecretEnc!), body.code) === null) fail("MFA_INVALID", "That code is not correct");
    const codes = recoveryCodes();
    await this.prisma.db.adminProfile.update({ where: { id: a.id }, data: { recoveryCodesHash: codes.hashes } });
    await this.admin.action(a.id, "security.recovery_codes_regenerated", "AdminProfile", a.id);
    return { recoveryCodes: codes.plain };
  }

  @Post("2fa/disable")
  @HttpCode(200)
  async disable(@Auth() auth: AuthContext, @Body(new ZodPipe(CodeBody)) body: { code: string }) {
    const a = await this.profile(auth);
    if (!a.totpEnabledAt || !a.totpSecretEnc) fail("VALIDATION_FAILED", "Two-factor is not on");
    if (admin2faRequired()) fail("FORBIDDEN", "Two-factor is required for all admins. Ask a super admin to reset it if you lost your phone.");
    if (verifyTotp(decrypt(a.totpSecretEnc!), body.code) === null) fail("MFA_INVALID", "That code is not correct");
    await this.prisma.db.adminProfile.update({ where: { id: a.id }, data: { totpEnabledAt: null, totpSecretEnc: null, recoveryCodesHash: [] } });
    await this.forget(auth.userId);
    await this.admin.action(a.id, "security.2fa_disabled", "AdminProfile", a.id);
    return { enabled: false };
  }
}
