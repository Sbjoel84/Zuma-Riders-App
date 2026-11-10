import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import { kobo } from "@zuma/contracts";
import { DriverOnboardBody, GoOnlineBody, LocationPoint, VehicleBody } from "@zuma/contracts";
import { z } from "zod";
import { fail } from "../../common/errors";
import { Auth, type AuthContext, IdempotencyKey, ZodPipe } from "../../common/http";
import { PrismaService } from "../../infra/prisma.service";
import { Scopes } from "../auth/auth.guard";
import { AvailabilityService } from "../geo/availability.service";
import { WalletService } from "../ledger/wallet.service";
import { WithdrawalsService } from "../ledger/withdrawals.service";
import { DocumentsService } from "../files/documents.service";
import { TripsService } from "../rides/trips.service";
import { DriversService } from "./drivers.service";

const BankBody = z.object({
  bankCode: z.string().trim().min(3).max(10),
  accountNumber: z.string().regex(/^\d{10}$/, "NUBAN account numbers have 10 digits"),
});
const DocBody = z.object({
  fileId: z.string().min(10),
  documentNumber: z.string().trim().min(3).max(40).optional(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
});
const DriverDocBody = DocBody.extend({ type: z.enum(["DRIVERS_LICENCE", "NATIONAL_ID", "PROFILE_PHOTO"]) });
const VehicleDocBody = DocBody.extend({ type: z.enum(["VEHICLE_REGISTRATION", "ROADWORTHINESS", "INSURANCE", "PHOTO_FRONT", "PHOTO_BACK"]) });
const WithdrawBody = z.object({ amount: kobo });

@Scopes("DRIVER")
@Controller("v1/driver")
export class DriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly availability: AvailabilityService,
    private readonly wallets: WalletService,
    private readonly trips: TripsService,
    private readonly prisma: PrismaService,
    private readonly withdrawals: WithdrawalsService,
    private readonly documents: DocumentsService,
  ) {}

  private async driverId(userId: string) {
    const d = await this.prisma.db.driver.findUnique({ where: { userId }, select: { id: true } });
    return d?.id ?? fail("DRIVER_NOT_VERIFIED", "Finish driver registration first");
  }

  @Get("me")
  me(@Auth() auth: AuthContext) {
    return this.drivers.me(auth.userId);
  }

  @Post("onboarding")
  onboard(@Auth() auth: AuthContext, @Body(new ZodPipe(DriverOnboardBody)) body: DriverOnboardBody) {
    return this.drivers.onboard(auth.userId, body);
  }

  @Post("vehicles")
  addVehicle(@Auth() auth: AuthContext, @Body(new ZodPipe(VehicleBody)) body: VehicleBody) {
    return this.drivers.addVehicle(auth.userId, body);
  }

  @Put("vehicles/:id/active")
  setActive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.drivers.setActiveVehicle(auth.userId, id);
  }

  @Post("availability/online")
  @HttpCode(200)
  online(@Auth() auth: AuthContext, @Body(new ZodPipe(GoOnlineBody)) body: { lat: number; lng: number }) {
    return this.availability.goOnline(auth.userId, body.lat, body.lng);
  }

  @Post("availability/offline")
  @HttpCode(200)
  async offline(@Auth() auth: AuthContext) {
    await this.availability.goOffline(await this.driverId(auth.userId));
    return { status: "OFFLINE" };
  }

  /** REST fallback for location when the socket is down. */
  @Post("location")
  @HttpCode(204)
  async location(@Auth() auth: AuthContext, @Body(new ZodPipe(LocationPoint)) body: z.infer<typeof LocationPoint>) {
    await this.availability.updateLocation(await this.driverId(auth.userId), body);
  }

  @Get("earnings")
  earnings(@Auth() auth: AuthContext, @Query("period") period = "day") {
    const p = z.enum(["day", "week", "month"]).parse(period);
    return this.trips.earnings(auth.userId, p);
  }

  @Get("wallet")
  wallet(@Auth() auth: AuthContext) {
    return this.wallets.view(auth.userId, "DRIVER");
  }

  /**
   * Payout account. The account name comes from the bank (name enquiry), and the account is registered
   * as a Paystack transfer recipient. We keep only the bank, account name, last four digits and the
   * recipient code — never the full account number.
   */
  @Put("bank-account")
  bank(@Auth() auth: AuthContext, @Body(new ZodPipe(BankBody)) body: z.infer<typeof BankBody>) {
    return this.withdrawals.setBankAccount(auth.userId, body.bankCode, body.accountNumber);
  }

  @Get("bank-account")
  async getBank(@Auth() auth: AuthContext) {
    const d = await this.prisma.db.driver.findUnique({ where: { userId: auth.userId } });
    return d?.bankAccountLast4 ? { bankName: d.bankName, bankCode: d.bankCode, accountName: d.bankAccountName, last4: d.bankAccountLast4, verified: Boolean(d.payoutRecipientCode) } : null;
  }

  @Get("documents")
  docs(@Auth() auth: AuthContext) {
    return this.documents.forDriver(auth.userId);
  }

  @Post("documents")
  submitDoc(@Auth() auth: AuthContext, @Body(new ZodPipe(DriverDocBody)) body: z.infer<typeof DriverDocBody>) {
    return this.documents.submitDriverDoc(auth.userId, body);
  }

  @Post("vehicles/:id/documents")
  submitVehicleDoc(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(VehicleDocBody)) body: z.infer<typeof VehicleDocBody>) {
    return this.documents.submitVehicleDoc(auth.userId, id, body);
  }

  @Post("withdrawals")
  async withdraw(@Auth() auth: AuthContext, @Body(new ZodPipe(WithdrawBody)) body: { amount: string }, @IdempotencyKey() key: string) {
    const w = await this.withdrawals.request(auth.userId, BigInt(body.amount), key);
    return { id: w.id, amount: w.amount.toString(), status: w.status };
  }

  @Get("withdrawals")
  listWithdrawals(@Auth() auth: AuthContext) {
    return this.withdrawals.list(auth.userId);
  }

  @Get("wallet/transactions")
  walletTxns(@Auth() auth: AuthContext, @Query("cursor") cursor?: string) {
    return this.wallets.transactions(auth.userId, "DRIVER", cursor);
  }
}
