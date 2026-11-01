import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { CancelBody, CompleteTripBody, CreateOfferBody, CreateRideRequestBody, EstimateBody, RaiseFareBody, RateBody, StartTripBody } from "@zuma/contracts";
import { Auth, type AuthContext, Idempotent, IdempotencyKey, ZodPipe } from "../../common/http";
import { Scopes } from "../auth/auth.guard";
import { PricingService } from "../pricing/pricing.service";
import { NegotiationService } from "./negotiation.service";
import { TripsService } from "./trips.service";

@Controller("v1")
export class RidesController {
  constructor(
    private readonly negotiation: NegotiationService,
    private readonly trips: TripsService,
    private readonly pricing: PricingService,
  ) {}

  // ---------- passenger: negotiation ----------

  @Scopes("PASSENGER")
  @Post("ride-requests/estimate")
  @HttpCode(200)
  async estimate(@Body(new ZodPipe(EstimateBody)) body: EstimateBody) {
    const { route: _route, cityId: _cityId, ...rest } = await this.pricing.estimate(body);
    return rest;
  }

  @Scopes("PASSENGER")
  @Post("ride-requests")
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateRideRequestBody)) body: CreateRideRequestBody, @IdempotencyKey() key: string) {
    return this.negotiation.create(auth.userId, body, key);
  }

  @Scopes("PASSENGER")
  @Get("ride-requests/:id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.negotiation.get(auth.userId, id);
  }

  @Scopes("PASSENGER")
  @Patch("ride-requests/:id/fare")
  raise(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(RaiseFareBody)) body: { proposedFare: string }) {
    return this.negotiation.raiseFare(auth.userId, id, BigInt(body.proposedFare));
  }

  @Scopes("PASSENGER")
  @Post("ride-requests/:id/cancel")
  @HttpCode(200)
  cancelRequest(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(CancelBody)) body: CancelBody) {
    return this.negotiation.cancelRequest(auth.userId, id, body);
  }

  @Scopes("PASSENGER")
  @Post("ride-requests/:id/offers/:offerId/accept")
  @HttpCode(200)
  @Idempotent()
  accept(@Auth() auth: AuthContext, @Param("id") id: string, @Param("offerId") offerId: string) {
    return this.negotiation.accept(auth.userId, id, offerId);
  }

  @Scopes("PASSENGER")
  @Post("ride-requests/:id/offers/:offerId/reject")
  @HttpCode(200)
  reject(@Auth() auth: AuthContext, @Param("id") id: string, @Param("offerId") offerId: string) {
    return this.negotiation.rejectOffer(auth.userId, id, offerId);
  }

  // ---------- driver: negotiation ----------

  @Scopes("DRIVER")
  @Get("driver/ride-requests")
  listForDriver(@Auth() auth: AuthContext) {
    return this.negotiation.listForDriver(auth.userId);
  }

  @Scopes("DRIVER")
  @Post("ride-requests/:id/offers")
  @Idempotent()
  offer(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(CreateOfferBody)) body: CreateOfferBody) {
    return this.negotiation.offer(auth.userId, id, body);
  }

  @Scopes("DRIVER")
  @Post("ride-requests/:id/offers/mine/withdraw")
  @HttpCode(204)
  async withdraw(@Auth() auth: AuthContext, @Param("id") id: string) {
    await this.negotiation.withdraw(auth.userId, id);
  }

  @Scopes("DRIVER")
  @Post("ride-requests/:id/decline")
  @HttpCode(204)
  async decline(@Auth() auth: AuthContext, @Param("id") id: string) {
    await this.negotiation.decline(auth.userId, id);
  }

  // ---------- trips (both parties) ----------

  @Get("rides/current")
  current(@Auth() auth: AuthContext) {
    return this.trips.current(auth);
  }

  @Get("rides")
  history(@Auth() auth: AuthContext, @Query("cursor") cursor?: string) {
    return this.trips.history(auth, cursor);
  }

  @Get("rides/:id")
  view(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.trips.view(id, auth);
  }

  @Scopes("DRIVER")
  @Post("rides/:id/en-route")
  @HttpCode(200)
  enRoute(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.trips.apply(id, "EN_ROUTE", auth);
  }

  @Scopes("DRIVER")
  @Post("rides/:id/arrived")
  @HttpCode(200)
  arrived(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.trips.apply(id, "ARRIVED", auth);
  }

  @Scopes("DRIVER")
  @Post("rides/:id/start")
  @HttpCode(200)
  start(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(StartTripBody)) body: { pin: string }) {
    return this.trips.apply(id, "START", auth, { pin: body.pin });
  }

  @Scopes("DRIVER")
  @Post("rides/:id/complete")
  @HttpCode(200)
  @Idempotent()
  complete(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(CompleteTripBody)) body: { lat: number; lng: number }) {
    return this.trips.apply(id, "COMPLETE", auth, { lat: body.lat, lng: body.lng });
  }

  @Post("rides/:id/cancel")
  @HttpCode(200)
  cancel(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(CancelBody)) body: CancelBody) {
    return this.trips.apply(id, "CANCEL", auth, { cancel: body });
  }

  @Post("rides/:id/ratings")
  rate(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(RateBody)) body: RateBody) {
    return this.trips.rate(id, auth, body);
  }
}
