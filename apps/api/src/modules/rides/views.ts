import type { DriverRequestView, OfferView, Place, RideRequestView, RideView } from "@zuma/contracts";
import type { Prisma } from "@zuma/database";
import { PricingService } from "../pricing/pricing.service";
import { PromosService } from "../promos/promos.service";
import { areaName, maskPhone, tripPin } from "./codes";

export const requestInclude = {
  category: true,
  pricingConfig: true,
  waypoints: { orderBy: { sequence: "asc" } },
  passenger: { include: { user: true } },
  ride: { select: { id: true } },
  promoCode: true,
  offers: {
    orderBy: { amount: "asc" },
    include: { driver: { include: { user: true } }, vehicle: { include: { category: true } } },
  },
} satisfies Prisma.RideRequestInclude;

export type RequestWithRelations = Prisma.RideRequestGetPayload<{ include: typeof requestInclude }>;

export const rideInclude = {
  rideRequest: { include: { waypoints: { orderBy: { sequence: "asc" } }, category: true } },
  passenger: { include: { user: true } },
  driver: { include: { user: true } },
  vehicle: { include: { category: true } },
  commission: true,
  ratings: true,
  payments: { where: { method: "CARD", status: "SUCCEEDED" }, include: { paymentMethod: true }, take: 1 },
} satisfies Prisma.RideInclude;

export type RideWithRelations = Prisma.RideGetPayload<{ include: typeof rideInclude }>;

function places(req: { pickupAddress: string; pickupLat: number; pickupLng: number; dropoffAddress: string; dropoffLat: number; dropoffLng: number }): { pickup: Place; dropoff: Place } {
  return {
    pickup: { address: req.pickupAddress, lat: req.pickupLat, lng: req.pickupLng },
    dropoff: { address: req.dropoffAddress, lat: req.dropoffLat, lng: req.dropoffLng },
  };
}

export function offerView(o: RequestWithRelations["offers"][number]): OfferView {
  return {
    id: o.id,
    amount: o.amount.toString(),
    isPassengerPrice: o.isPassengerPrice,
    status: o.status === "PENDING" && o.expiresAt < new Date() ? "EXPIRED" : o.status,
    revision: o.revision,
    etaToPickupS: o.etaToPickupS,
    distanceToPickupM: o.distanceToPickupM,
    expiresAt: o.expiresAt.toISOString(),
    // Before acceptance the passenger sees first name, rating and car — never phone or plate.
    driver: { firstName: o.driver.user.firstName, ratingAvg: o.driver.ratingAvg.toString(), tripsCompleted: o.driver.tripsCompleted },
    vehicle: { make: o.vehicle.make, model: o.vehicle.model, colour: o.vehicle.colour, categoryKey: o.vehicle.category.key },
  };
}

export function requestView(r: RequestWithRelations): RideRequestView {
  const b = PricingService.bounds(r.pricingConfig, r.routeDistanceM, r.routeDurationS);
  const open = ["SEARCHING", "OFFERS_RECEIVED", "REQUESTED"].includes(r.status);
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    ...places(r),
    categoryKey: r.category.key,
    distanceM: r.routeDistanceM,
    durationS: r.routeDurationS,
    suggestedFare: r.suggestedFare.toString(),
    proposedFare: r.proposedFare.toString(),
    minFare: b.min.toString(),
    maxFare: b.max.toString(),
    paymentMethod: r.paymentMethod as RideRequestView["paymentMethod"],
    expiresAt: r.expiresAt.toISOString(),
    offers: open ? r.offers.filter((o) => o.status === "PENDING" && o.expiresAt > new Date()).map(offerView) : r.offers.filter((o) => o.status === "ACCEPTED").map(offerView),
    rideId: r.ride?.id ?? null,
    promo: r.promoCode ? { code: r.promoCode.code, description: PromosService.describe(r.promoCode) } : null,
  };
}

export function driverRequestView(r: RequestWithRelations, driverId: string, distanceToPickupM: number | null): DriverRequestView {
  const mine = r.offers.find((o) => o.driverId === driverId);
  return {
    requestId: r.id,
    code: r.code,
    // Rounded to ~100 m until a driver is selected.
    pickup: { area: areaName(r.pickupAddress), lat: Math.round(r.pickupLat * 1000) / 1000, lng: Math.round(r.pickupLng * 1000) / 1000 },
    dropoffArea: areaName(r.dropoffAddress),
    distanceM: r.routeDistanceM,
    durationS: r.routeDurationS,
    distanceToPickupM,
    proposedFare: r.proposedFare.toString(),
    maxCounter: PricingService.maxCounter(r.proposedFare, r.pricingConfig).toString(),
    categoryKey: r.category.key,
    paymentMethod: r.paymentMethod as DriverRequestView["paymentMethod"],
    passenger: { firstName: r.passenger.user.firstName, ratingAvg: r.passenger.ratingAvg.toString() },
    expiresAt: r.expiresAt.toISOString(),
    myOffer: mine ? { id: mine.id, amount: mine.amount.toString(), status: mine.status } : null,
  };
}

export function rideView(r: RideWithRelations, viewer: "PASSENGER" | "DRIVER" | "ADMIN", driverPos: { lat: number; lng: number } | null, unreadMessages = 0): RideView {
  const req = r.rideRequest;
  const myRating = r.ratings.find((x) => x.raterRole === viewer)?.stars ?? null;
  const pinVisible = viewer === "PASSENGER" && ["DRIVER_SELECTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED"].includes(r.status);
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    version: r.version,
    agreedFare: r.agreedFare.toString(),
    finalFare: r.finalFare?.toString() ?? null,
    commissionAmount: viewer === "PASSENGER" ? null : (r.commission?.amount.toString() ?? null),
    discountAmount: r.discountAmount.toString(),
    passengerPays: (r.finalFare ?? r.agreedFare + r.waitingCharge - r.discountAmount).toString(),
    paymentMethod: r.paymentMethod as RideView["paymentMethod"],
    card: viewer === "DRIVER" || !r.payments[0]?.paymentMethod ? null : { brand: r.payments[0].paymentMethod.cardBrand, last4: r.payments[0].paymentMethod.cardLast4 },
    ...places(req),
    distanceM: req.routeDistanceM,
    durationS: req.routeDurationS,
    passenger: { firstName: r.passenger.user.firstName, ratingAvg: r.passenger.ratingAvg.toString(), phoneMasked: maskPhone(r.passenger.user.phoneE164) },
    driver: { firstName: r.driver.user.firstName, ratingAvg: r.driver.ratingAvg.toString(), tripsCompleted: r.driver.tripsCompleted, lat: driverPos?.lat ?? null, lng: driverPos?.lng ?? null },
    vehicle: { make: r.vehicle.make, model: r.vehicle.model, colour: r.vehicle.colour, plateNumber: r.vehicle.plateNumber, categoryKey: r.vehicle.category.key },
    tripPin: pinVisible ? tripPin(r.id) : null,
    assignedAt: r.assignedAt.toISOString(),
    arrivedAt: r.arrivedAt?.toISOString() ?? null,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    myRating,
    shareToken: viewer === "PASSENGER" ? r.shareToken : null,
    unreadMessages,
  };
}
