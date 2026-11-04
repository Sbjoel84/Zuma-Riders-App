import { Injectable } from "@nestjs/common";
import type { CancelBody, CreateOfferBody, CreateRideRequestBody, DriverRequestView, RideRequestView } from "@zuma/contracts";
import { DomainError, fail } from "../../common/errors";
import { MapsService } from "../../infra/maps.service";
import { isUniqueViolation, PrismaService } from "../../infra/prisma.service";
import { AvailabilityService } from "../geo/availability.service";
import { WalletService } from "../ledger/wallet.service";
import { PricingService } from "../pricing/pricing.service";
import { EventsService } from "../realtime/events.service";
import { shortCode, tripPinHash } from "./codes";
import { MatchingService } from "./matching.service";
import { ACTIVE_RIDE_STATUSES, OPEN_REQUEST_STATUSES } from "./state-machine";
import { driverRequestView, offerView, requestInclude, requestView } from "./views";

@Injectable()
export class NegotiationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly matching: MatchingService,
    private readonly availability: AvailabilityService,
    private readonly wallets: WalletService,
    private readonly events: EventsService,
    private readonly maps: MapsService,
  ) {}

  private async passengerFor(userId: string) {
    const p = await this.prisma.db.passengerProfile.findUnique({ where: { userId }, include: { user: true } });
    if (!p) fail("FORBIDDEN", "Open the passenger app to create a passenger account");
    if (!p!.user.firstName) fail("PROFILE_INCOMPLETE", "Add your name before booking");
    if (p!.user.status !== "ACTIVE") fail("FORBIDDEN", "Your account is suspended. Contact support.");
    return p!;
  }

  private async driverFor(userId: string) {
    const d = await this.prisma.db.driver.findUnique({ where: { userId }, include: { user: true, activeVehicle: { include: { category: true } } } });
    if (!d) fail("DRIVER_NOT_ELIGIBLE", "Finish driver registration first");
    return d!;
  }

  // ---------------- passenger ----------------

  async create(userId: string, body: CreateRideRequestBody, idempotencyKey: string): Promise<RideRequestView> {
    const passenger = await this.passengerFor(userId);

    const existing = await this.prisma.db.rideRequest.findUnique({ where: { idempotencyKey }, include: requestInclude });
    if (existing) {
      if (existing.passengerId !== passenger.id) fail("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key belongs to another request");
      return requestView(existing);
    }

    const activeRide = await this.prisma.db.ride.findFirst({ where: { passengerId: passenger.id, status: { in: ACTIVE_RIDE_STATUSES } } });
    if (activeRide) fail("ACTIVE_REQUEST_EXISTS", "You already have a trip in progress", { rideId: activeRide.id });
    const openReq = await this.prisma.db.rideRequest.findFirst({ where: { passengerId: passenger.id, status: { in: OPEN_REQUEST_STATUSES } } });
    if (openReq) fail("ACTIVE_REQUEST_EXISTS", "You already have an open request", { requestId: openReq.id });

    if (body.paymentMethod === "CARD") fail("VALIDATION_FAILED", "Card payments are coming soon. Choose cash or wallet.");

    const est = await this.pricing.estimate({ pickup: body.pickup, dropoff: body.dropoff, categoryKey: body.categoryKey });
    const category = await this.prisma.db.vehicleCategory.findUniqueOrThrow({ where: { key: body.categoryKey } });
    const cfg = await this.pricing.activeConfig(est.serviceAreaId, category.id);
    const bounds = PricingService.bounds(cfg, est.distanceM, est.durationS);
    const proposed = BigInt(body.proposedFare);
    PricingService.assertProposal(proposed, bounds);

    if (body.paymentMethod === "WALLET") {
      const w = await this.wallets.ensureWallet(userId, "PASSENGER");
      if (w.availableBalance < proposed) fail("WALLET_INSUFFICIENT", "Your wallet balance is too low for this fare");
    }

    const area = await this.prisma.db.serviceArea.findUniqueOrThrow({ where: { id: est.serviceAreaId } });
    const expiresAt = new Date(Date.now() + cfg.requestTtlSeconds * 1000);

    let created;
    for (let attempt = 0; ; attempt++) {
      try {
        created = await this.prisma.db.rideRequest.create({
          data: {
            code: shortCode("R"), passengerId: passenger.id, cityId: est.cityId, serviceAreaId: area.id, categoryId: category.id,
            pricingConfigId: cfg.id, status: "SEARCHING",
            pickupAddress: body.pickup.address, pickupLat: body.pickup.lat, pickupLng: body.pickup.lng,
            dropoffAddress: body.dropoff.address, dropoffLat: body.dropoff.lat, dropoffLng: body.dropoff.lng,
            routeDistanceM: est.distanceM, routeDurationS: est.durationS, routePolyline: est.polyline,
            suggestedFare: bounds.suggested, proposedFare: proposed, paymentMethod: body.paymentMethod, passengerNote: body.note,
            idempotencyKey, currentRadiusM: area.searchRadiusM, expiresAt,
            waypoints: {
              create: [
                { sequence: 0, type: "PICKUP", address: body.pickup.address, lat: body.pickup.lat, lng: body.pickup.lng },
                { sequence: 1, type: "DROPOFF", address: body.dropoff.address, lat: body.dropoff.lat, lng: body.dropoff.lng },
              ],
            },
            negotiationEvents: { create: { actorType: "PASSENGER", actorUserId: userId, action: "PASSENGER_PROPOSED", amount: proposed, metadata: { suggested: bounds.suggested.toString() } } },
          },
        });
        break;
      } catch (e) {
        if (isUniqueViolation(e, "ride_request_one_open_per_passenger")) fail("ACTIVE_REQUEST_EXISTS", "You already have an open request");
        if (isUniqueViolation(e, "idempotencyKey")) {
          const again = await this.prisma.db.rideRequest.findUniqueOrThrow({ where: { idempotencyKey }, include: requestInclude });
          return requestView(again);
        }
        if (isUniqueViolation(e, "code") && attempt < 3) continue;
        throw e;
      }
    }

    await this.matching.start(created.id, expiresAt);
    return this.get(userId, created.id);
  }

  async get(userId: string, requestId: string): Promise<RideRequestView> {
    const r = await this.prisma.db.rideRequest.findUnique({ where: { id: requestId }, include: requestInclude });
    if (!r || r.passenger.userId !== userId) fail("NOT_FOUND", "Request not found");
    return requestView(r!);
  }

  async raiseFare(userId: string, requestId: string, newFare: bigint): Promise<RideRequestView> {
    const r = await this.prisma.db.rideRequest.findUnique({ where: { id: requestId }, include: requestInclude });
    if (!r || r.passenger.userId !== userId) fail("NOT_FOUND", "Request not found");
    if (!OPEN_REQUEST_STATUSES.includes(r!.status) || r!.expiresAt < new Date()) fail("REQUEST_CLOSED", "This request is no longer open");
    if (newFare <= r!.proposedFare) fail("VALIDATION_FAILED", "The new fare must be higher than your current offer");
    PricingService.assertProposal(newFare, PricingService.bounds(r!.pricingConfig, r!.routeDistanceM, r!.routeDurationS));
    await this.prisma.db.$transaction([
      this.prisma.db.rideRequest.update({ where: { id: requestId }, data: { proposedFare: newFare } }),
      this.prisma.db.fareNegotiation.create({ data: { rideRequestId: requestId, actorType: "PASSENGER", actorUserId: userId, action: "PASSENGER_RAISED_FARE", amount: newFare, previousAmount: r!.proposedFare } }),
    ]);
    await this.matching.notifyUpdate(requestId);
    await this.matching.dispatch(requestId);
    return this.get(userId, requestId);
  }

  async cancelRequest(userId: string, requestId: string, body: CancelBody): Promise<RideRequestView> {
    const r = await this.prisma.db.rideRequest.findUnique({ where: { id: requestId }, include: { passenger: true } });
    if (!r || r.passenger.userId !== userId) fail("NOT_FOUND", "Request not found");
    const changed = await this.prisma.db.$transaction(async (tx) => {
      const c = await tx.rideRequest.updateMany({ where: { id: requestId, status: { in: OPEN_REQUEST_STATUSES } }, data: { status: "CANCELLED", cancelledAt: new Date() } });
      if (c.count === 0) return false;
      await tx.rideOffer.updateMany({ where: { rideRequestId: requestId, status: "PENDING" }, data: { status: "REJECTED", respondedAt: new Date() } });
      await tx.fareNegotiation.create({ data: { rideRequestId: requestId, actorType: "PASSENGER", actorUserId: userId, action: "PASSENGER_REJECTED_OFFER", metadata: { cancelled: true, reasonCode: body.reasonCode } } });
      return true;
    });
    if (!changed) fail("REQUEST_CLOSED", "This request can no longer be cancelled here");
    await this.matching.notifyClosed(requestId, "CANCELLED");
    return this.get(userId, requestId);
  }

  async rejectOffer(userId: string, requestId: string, offerId: string): Promise<RideRequestView> {
    const offer = await this.prisma.db.rideOffer.findUnique({ where: { id: offerId }, include: { rideRequest: { include: { passenger: true } } } });
    if (!offer || offer.rideRequestId !== requestId || offer.rideRequest.passenger.userId !== userId) fail("NOT_FOUND", "Offer not found");
    const c = await this.prisma.db.rideOffer.updateMany({ where: { id: offerId, status: "PENDING" }, data: { status: "REJECTED", respondedAt: new Date() } });
    if (c.count) {
      await this.prisma.db.fareNegotiation.create({ data: { rideRequestId: requestId, offerId, actorType: "PASSENGER", actorUserId: userId, action: "PASSENGER_REJECTED_OFFER", amount: offer!.amount } });
      this.events.toDriver(offer!.driverId, "offer.result", { requestId, offerId, result: "REJECTED" });
    }
    return this.get(userId, requestId);
  }

  /**
   * The critical section. Row locks serialise concurrent accepts on one request; the unique constraints on
   * Ride(rideRequestId), Ride(acceptedOfferId) and the partial unique index on active rides per driver make a
   * double assignment impossible even if this code were wrong.
   */
  async accept(userId: string, requestId: string, offerId: string): Promise<{ rideId: string }> {
    let rideId: string;
    let driverUserId: string;
    let driverId: string;
    try {
      ({ rideId, driverUserId, driverId } = await this.prisma.db.$transaction(async (tx) => {
        const [req] = await tx.$queryRaw<Array<{ id: string; status: string; expiresAt: Date; passengerId: string; paymentMethod: string; proposedFare: bigint }>>`
          SELECT id, status, "expiresAt", "passengerId", "paymentMethod", "proposedFare" FROM "RideRequest" WHERE id = ${requestId} FOR UPDATE`;
        const passenger = await tx.passengerProfile.findUnique({ where: { userId } });
        if (!req || !passenger || req.passengerId !== passenger.id) throw new DomainError("NOT_FOUND", "Request not found");
        if (!["SEARCHING", "OFFERS_RECEIVED"].includes(req.status) || req.expiresAt < new Date()) throw new DomainError("REQUEST_CLOSED", "This request is no longer open");

        const [offer] = await tx.$queryRaw<Array<{ id: string; status: string; expiresAt: Date; driverId: string; vehicleId: string; amount: bigint; rideRequestId: string }>>`
          SELECT id, status, "expiresAt", "driverId", "vehicleId", amount, "rideRequestId" FROM "RideOffer" WHERE id = ${offerId} FOR UPDATE`;
        if (!offer || offer.rideRequestId !== requestId) throw new DomainError("NOT_FOUND", "Offer not found");
        if (offer.status !== "PENDING") throw new DomainError("DRIVER_NO_LONGER_AVAILABLE", "This driver withdrew their offer");
        if (offer.expiresAt < new Date()) throw new DomainError("OFFER_EXPIRED", "This offer has expired");

        if (req.paymentMethod === "WALLET") {
          const w = await tx.wallet.findUnique({ where: { userId_ownerType: { userId, ownerType: "PASSENGER" } } });
          if (!w || w.availableBalance < offer.amount) throw new DomainError("WALLET_INSUFFICIENT", "Your wallet balance is too low for this offer");
        }

        const full = await tx.rideRequest.findUniqueOrThrow({ where: { id: requestId }, include: { pricingConfig: true } });
        const driver = await tx.driver.findUniqueOrThrow({ where: { id: offer.driverId } });

        const id = (await tx.$queryRaw<Array<{ id: string }>>`SELECT gen_random_uuid()::text AS id`)[0]!.id;
        await tx.ride.create({
          data: {
            id, code: full.code.replace("R-", "T-"), rideRequestId: requestId, acceptedOfferId: offerId,
            passengerId: passenger.id, driverId: offer.driverId, vehicleId: offer.vehicleId,
            agreedFare: offer.amount, commissionBps: full.pricingConfig.commissionBps,
            paymentMethod: full.paymentMethod, tripPinHash: tripPinHash(id), status: "DRIVER_SELECTED",
            statusHistory: { create: { fromStatus: null, toStatus: "DRIVER_SELECTED", actorType: "PASSENGER", actorUserId: userId } },
          },
        });
        await tx.rideOffer.update({ where: { id: offerId }, data: { status: "ACCEPTED", respondedAt: new Date() } });
        await tx.rideOffer.updateMany({ where: { rideRequestId: requestId, status: "PENDING", id: { not: offerId } }, data: { status: "REJECTED", respondedAt: new Date() } });
        await tx.rideRequest.update({ where: { id: requestId }, data: { status: "DRIVER_SELECTED" } });
        await tx.fareNegotiation.create({ data: { rideRequestId: requestId, offerId, actorType: "PASSENGER", actorUserId: userId, action: "PASSENGER_ACCEPTED_OFFER", amount: offer.amount } });
        return { rideId: id, driverUserId: driver.userId, driverId: driver.id };
      }));
    } catch (e) {
      if (e instanceof DomainError) throw e;
      if (isUniqueViolation(e, "ride_one_active_per_driver")) {
        await this.prisma.db.rideOffer.updateMany({ where: { id: offerId, status: "PENDING" }, data: { status: "WITHDRAWN" } });
        fail("DRIVER_NO_LONGER_AVAILABLE", "This driver just took another trip. Pick another offer.");
      }
      if (isUniqueViolation(e)) fail("REQUEST_CLOSED", "This request was already accepted");
      throw e;
    }

    // Post-commit side effects.
    await this.availability.markBusy(driverId, rideId);
    this.events.joinRide(rideId, [userId, driverUserId]);
    this.events.toDriver(driverId, "ride.assigned", { rideId, requestId });
    this.events.toDriver(driverId, "offer.result", { requestId, offerId, result: "ACCEPTED", rideId });
    this.events.toUser(userId, "ride_request.status", { requestId, status: "DRIVER_SELECTED", rideId });
    const others = await this.prisma.db.rideOffer.findMany({ where: { rideRequestId: requestId, id: { not: offerId } }, select: { id: true, driverId: true } });
    others.forEach((o) => this.events.toDriver(o.driverId, "offer.result", { requestId, offerId: o.id, result: "REJECTED" }));
    await this.matching.notifyClosed(requestId, "ASSIGNED_OTHER", driverId);
    return { rideId };
  }

  // ---------------- driver ----------------

  async listForDriver(userId: string): Promise<DriverRequestView[]> {
    const d = await this.driverFor(userId);
    const dispatches = await this.prisma.db.rideDispatch.findMany({
      where: { driverId: d.id, declinedAt: null, rideRequest: { status: { in: OPEN_REQUEST_STATUSES }, expiresAt: { gt: new Date() } } },
      orderBy: { sentAt: "desc" },
      take: 20,
    });
    const out: DriverRequestView[] = [];
    for (const disp of dispatches) {
      const r = await this.prisma.db.rideRequest.findUniqueOrThrow({ where: { id: disp.rideRequestId }, include: requestInclude });
      out.push(driverRequestView(r, d.id, disp.distanceToPickupM));
    }
    return out;
  }

  async offer(userId: string, requestId: string, body: CreateOfferBody) {
    const d = await this.driverFor(userId);
    if (d.verificationStatus !== "APPROVED" || !d.activeVehicle || d.activeVehicle.status !== "APPROVED") fail("DRIVER_NOT_ELIGIBLE", "Your account or vehicle is not approved yet");
    if (!(await this.availability.position(d.id))) fail("DRIVER_NOT_ELIGIBLE", "Go online to make offers");
    if (await this.availability.isBusy(d.id)) fail("DRIVER_NOT_ELIGIBLE", "Finish your current trip first");

    const dispatch = await this.prisma.db.rideDispatch.findUnique({ where: { rideRequestId_driverId: { rideRequestId: requestId, driverId: d.id } } });
    if (!dispatch) fail("NOT_FOUND", "Request not found");
    const r = await this.prisma.db.rideRequest.findUniqueOrThrow({ where: { id: requestId }, include: requestInclude });
    if (!OPEN_REQUEST_STATUSES.includes(r.status) || r.expiresAt < new Date()) fail("REQUEST_CLOSED", "This request is no longer open");
    if (r.categoryId !== d.activeVehicle!.categoryId) fail("DRIVER_NOT_ELIGIBLE", "Your vehicle is not in the requested category");

    const isPassengerPrice = "acceptPassengerPrice" in body;
    const amount = isPassengerPrice ? r.proposedFare : BigInt(body.amount);
    const max = PricingService.maxCounter(r.proposedFare, r.pricingConfig);
    if (!isPassengerPrice && (amount < r.proposedFare || amount > max)) {
      fail("COUNTER_OFFER_OUT_OF_RANGE", `Offer between ₦${(r.proposedFare / 100n).toLocaleString()} and ₦${(max / 100n).toLocaleString()}`, { min: r.proposedFare.toString(), max: max.toString() });
    }

    const pos = await this.availability.position(d.id);
    let eta: number | null = null;
    let dist: number | null = dispatch!.distanceToPickupM;
    if (pos) {
      const route = await this.maps.route(pos, { lat: r.pickupLat, lng: r.pickupLng }).catch(() => null);
      if (route) {
        eta = route.durationS;
        dist = route.distanceM;
      }
    }
    const expiresAt = new Date(Date.now() + r.pricingConfig.offerTtlSeconds * 1000);
    const prev = r.offers.find((o) => o.driverId === d.id);
    if (prev && prev.status === "REJECTED") fail("REQUEST_CLOSED", "The passenger declined your offer");
    if (prev && prev.status === "ACCEPTED") fail("REQUEST_CLOSED", "Your offer was already accepted");

    const saved = await this.prisma.db.$transaction(async (tx) => {
      const o = await tx.rideOffer.upsert({
        where: { rideRequestId_driverId: { rideRequestId: requestId, driverId: d.id } },
        create: { rideRequestId: requestId, driverId: d.id, vehicleId: d.activeVehicle!.id, amount, isPassengerPrice, etaToPickupS: eta, distanceToPickupM: dist, expiresAt },
        update: { amount, isPassengerPrice, etaToPickupS: eta, distanceToPickupM: dist, expiresAt, status: "PENDING", revision: { increment: 1 } },
      });
      await tx.fareNegotiation.create({
        data: {
          rideRequestId: requestId, offerId: o.id, actorType: "DRIVER", actorUserId: userId,
          action: prev ? "DRIVER_UPDATED_OFFER" : isPassengerPrice ? "DRIVER_ACCEPTED_PRICE" : "DRIVER_COUNTER_OFFER",
          amount, previousAmount: prev?.amount,
        },
      });
      await tx.rideRequest.updateMany({ where: { id: requestId, status: "SEARCHING" }, data: { status: "OFFERS_RECEIVED" } });
      return o;
    });

    const fresh = await this.prisma.db.rideRequest.findUniqueOrThrow({ where: { id: requestId }, include: requestInclude });
    const ov = fresh.offers.find((o) => o.id === saved.id)!;
    this.events.toUser(fresh.passenger.userId, "offer.upserted", { requestId, offer: offerView(ov) });
    return driverRequestView(fresh, d.id, dist);
  }

  async withdraw(userId: string, requestId: string) {
    const d = await this.driverFor(userId);
    const o = await this.prisma.db.rideOffer.findUnique({ where: { rideRequestId_driverId: { rideRequestId: requestId, driverId: d.id } }, include: { rideRequest: { include: { passenger: true } } } });
    if (!o) fail("NOT_FOUND", "You have no offer on this request");
    const c = await this.prisma.db.rideOffer.updateMany({ where: { id: o!.id, status: "PENDING" }, data: { status: "WITHDRAWN" } });
    if (c.count) {
      await this.prisma.db.fareNegotiation.create({ data: { rideRequestId: requestId, offerId: o!.id, actorType: "DRIVER", actorUserId: userId, action: "DRIVER_WITHDREW", amount: o!.amount } });
      this.events.toUser(o!.rideRequest.passenger.userId, "offer.withdrawn", { requestId, offerId: o!.id });
    }
  }

  async decline(userId: string, requestId: string) {
    const d = await this.driverFor(userId);
    const c = await this.prisma.db.rideDispatch.updateMany({ where: { rideRequestId: requestId, driverId: d.id, declinedAt: null }, data: { declinedAt: new Date() } });
    if (c.count) await this.prisma.db.fareNegotiation.create({ data: { rideRequestId: requestId, actorType: "DRIVER", actorUserId: userId, action: "DRIVER_DECLINED" } });
  }
}

