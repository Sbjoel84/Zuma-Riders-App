import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { CompleteProfileBody, type MeResponse } from "@zuma/contracts";
import { fail } from "../../common/errors";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { isUniqueViolation, PrismaService } from "../../infra/prisma.service";
import { Scopes } from "../auth/auth.guard";
import { WalletService } from "../ledger/wallet.service";

@Controller("v1")
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletService,
  ) {}

  @Get("me")
  async me(@Auth() auth: AuthContext): Promise<MeResponse> {
    const u = await this.prisma.db.user.findUnique({ where: { id: auth.userId }, include: { roles: { include: { role: true } }, driver: true, passengerProfile: true } });
    if (!u) fail("NOT_FOUND", "Account not found");
    return {
      id: u!.id,
      phone: u!.phoneE164,
      firstName: u!.firstName,
      lastName: u!.lastName,
      email: u!.email,
      profileComplete: Boolean(u!.firstName && u!.termsAcceptedAt),
      roles: u!.roles.map((r) => r.role.key),
      driver: u!.driver ? { id: u!.driver.id, verificationStatus: u!.driver.verificationStatus, activeVehicleId: u!.driver.activeVehicleId, ratingAvg: u!.driver.ratingAvg.toString(), tripsCompleted: u!.driver.tripsCompleted } : null,
      passenger: u!.passengerProfile ? { id: u!.passengerProfile.id, ratingAvg: u!.passengerProfile.ratingAvg.toString(), tripsCompleted: u!.passengerProfile.tripsCompleted } : null,
    };
  }

  @Post("me/profile")
  async completeProfile(@Auth() auth: AuthContext, @Body(new ZodPipe(CompleteProfileBody)) body: CompleteProfileBody) {
    try {
      await this.prisma.db.user.update({
        where: { id: auth.userId },
        data: {
          firstName: body.firstName, lastName: body.lastName, email: body.email,
          termsAcceptedAt: new Date(), termsVersion: body.termsVersion, privacyConsentAt: new Date(), marketingConsent: body.marketingConsent,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) fail("VALIDATION_FAILED", "That email is already used by another account");
      throw e;
    }
    if (body.referralCode) {
      const referrer = await this.prisma.db.user.findUnique({ where: { referralCode: body.referralCode.toUpperCase() } });
      const already = await this.prisma.db.referral.findUnique({ where: { refereeId: auth.userId } });
      const me = await this.prisma.db.user.findUniqueOrThrow({ where: { id: auth.userId } });
      const isNew = me.createdAt > new Date(Date.now() - 7 * 86400_000);
      if (referrer && referrer.id !== auth.userId && !already && isNew) {
        await this.prisma.db.referral.create({ data: { referrerId: referrer.id, refereeId: auth.userId, refereeRole: auth.scope === "DRIVER" ? "DRIVER" : "PASSENGER" } });
      }
    }
    return this.me(auth);
  }

  @Scopes("PASSENGER")
  @Get("wallet")
  wallet(@Auth() auth: AuthContext) {
    return this.wallets.view(auth.userId, "PASSENGER");
  }

  @Scopes("PASSENGER")
  @Get("wallet/transactions")
  walletTxns(@Auth() auth: AuthContext, @Query("cursor") cursor?: string) {
    return this.wallets.transactions(auth.userId, "PASSENGER", cursor);
  }
}
