import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import { DriverOnboardBody, GoOnlineBody, LocationPoint, VehicleBody } from "@zuma/contracts";
import { z } from "zod";
import { fail } from "../../common/errors";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { PrismaService } from "../../infra/prisma.service";
import { Scopes } from "../auth/auth.guard";
import { AvailabilityService } from "../geo/availability.service";
import { WalletService } from "../ledger/wallet.service";
import { TripsService } from "../rides/trips.service";
import { DriversService } from "./drivers.service";

@Scopes("DRIVER")
@Controller("v1/driver")
export class DriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly availability: AvailabilityService,
    private readonly wallets: WalletService,
    private readonly trips: TripsService,
    private readonly prisma: PrismaService,
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

  @Get("wallet/transactions")
  walletTxns(@Auth() auth: AuthContext, @Query("cursor") cursor?: string) {
    return this.wallets.transactions(auth.userId, "DRIVER", cursor);
  }
}
