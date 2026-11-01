import { Controller, Get, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AllExceptionsFilter, IdempotencyInterceptor } from "./common/http";
import { MapsService } from "./infra/maps.service";
import { PrismaService } from "./infra/prisma.service";
import { RedisService } from "./infra/redis.service";
import { SmsService } from "./infra/sms.service";
import { AdminController } from "./modules/admin/admin.controller";
import { AuthController } from "./modules/auth/auth.controller";
import { AuthGuard, Public } from "./modules/auth/auth.guard";
import { AuthService } from "./modules/auth/auth.service";
import { TokensService } from "./modules/auth/tokens.service";
import { DriversController } from "./modules/drivers/drivers.controller";
import { DriversService } from "./modules/drivers/drivers.service";
import { AvailabilityService } from "./modules/geo/availability.service";
import { LedgerService } from "./modules/ledger/ledger.service";
import { WalletService } from "./modules/ledger/wallet.service";
import { PricingService } from "./modules/pricing/pricing.service";
import { EventsService } from "./modules/realtime/events.service";
import { RealtimeGateway } from "./modules/realtime/realtime.gateway";
import { JobsService } from "./modules/rides/jobs.service";
import { MatchingService } from "./modules/rides/matching.service";
import { NegotiationService } from "./modules/rides/negotiation.service";
import { RidesController } from "./modules/rides/rides.controller";
import { SettlementService } from "./modules/rides/settlement.service";
import { TripsService } from "./modules/rides/trips.service";
import { UsersController } from "./modules/users/users.controller";

@Controller()
class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get("health/live")
  live() {
    return { ok: true };
  }

  @Public()
  @Get("health/ready")
  async ready() {
    await this.prisma.db.$queryRaw`SELECT 1`;
    await this.redis.client.ping();
    return { ok: true };
  }
}

/**
 * Single Nest module for the ride slice. Providers are grouped by the module layout in ARCHITECTURE §4 and
 * will be split into feature modules as the remaining phases land.
 */
@Module({
  controllers: [HealthController, AuthController, UsersController, DriversController, RidesController, AdminController],
  providers: [
    PrismaService, RedisService, SmsService, MapsService,
    TokensService, AuthService,
    WalletService, LedgerService,
    EventsService, RealtimeGateway,
    AvailabilityService, PricingService,
    JobsService, MatchingService, SettlementService, NegotiationService, TripsService,
    DriversService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
