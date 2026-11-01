/**
 * Shared contracts between the API and all clients.
 * Money is always a string of kobo on the wire ("650000" = ₦6,500.00).
 */
import { z } from "zod";

// ---------- primitives ----------

export const kobo = z
  .string()
  .regex(/^\d+$/, "Amount must be whole kobo as a string")
  .refine((s) => s.length <= 15, "Amount too large");

export const phoneE164 = z.string().regex(/^\+[1-9]\d{7,14}$/, "Phone number must be in international format");

/** Accepts 080..., 80..., 234..., +234... and returns +234XXXXXXXXXX. Other countries must already be E.164. */
export function normalizeNigerianPhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
  if (/^0[789][01]\d{8}$/.test(digits)) return "+234" + digits.slice(1);
  if (/^[789][01]\d{8}$/.test(digits)) return "+234" + digits;
  if (/^234[789][01]\d{8}$/.test(digits)) return "+" + digits;
  return null;
}

export const latLng = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof latLng>;

export const place = latLng.extend({
  address: z.string().min(1).max(300),
  placeId: z.string().max(300).optional(),
});
export type Place = z.infer<typeof place>;

// ---------- money helpers ----------

export const Money = {
  fromNaira: (n: number): bigint => BigInt(Math.round(n * 100)),
  toNaira: (k: bigint | string): number => Number(BigInt(k)) / 100,
  format: (k: bigint | string): string => {
    const n = BigInt(k);
    const whole = n / 100n;
    const frac = n % 100n;
    const s = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return "₦" + s + (frac === 0n ? "" : "." + frac.toString().padStart(2, "0"));
  },
  /** commission = floor(fare * bps / 10000); remainder stays with the driver */
  commission: (fare: bigint, bps: number): bigint => (fare * BigInt(bps)) / 10000n,
};

// ---------- enums (mirror Prisma enums) ----------

export const RideStatus = z.enum([
  "REQUESTED", "SEARCHING", "OFFERS_RECEIVED", "DRIVER_SELECTED", "DRIVER_EN_ROUTE",
  "DRIVER_ARRIVED", "TRIP_STARTED", "TRIP_COMPLETED", "CANCELLED", "EXPIRED", "DISPUTED",
]);
export type RideStatus = z.infer<typeof RideStatus>;

export const PaymentMethodType = z.enum(["CASH", "WALLET", "CARD"]);
export type PaymentMethodType = z.infer<typeof PaymentMethodType>;

export const AppScope = z.enum(["PASSENGER", "DRIVER", "ADMIN"]);
export type AppScope = z.infer<typeof AppScope>;

// ---------- auth ----------

export const OtpRequestBody = z.object({
  phone: z.string().min(7).max(20),
  appScope: AppScope,
});
export type OtpRequestBody = z.infer<typeof OtpRequestBody>;

export const DeviceInfo = z.object({
  installId: z.string().min(8).max(100),
  platform: z.enum(["ANDROID", "IOS", "WEB"]),
  model: z.string().max(100).optional(),
  appVersion: z.string().max(30).optional(),
});

export const OtpVerifyBody = z.object({
  otpId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
  device: DeviceInfo,
});
export type OtpVerifyBody = z.infer<typeof OtpVerifyBody>;

export const RefreshBody = z.object({ refreshToken: z.string().min(20) });

export const CompleteProfileBody = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  email: z.string().email().max(200).optional(),
  referralCode: z.string().max(20).optional(),
  termsVersion: z.string().min(1).max(20),
  marketingConsent: z.boolean().default(false),
});
export type CompleteProfileBody = z.infer<typeof CompleteProfileBody>;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface MeResponse {
  id: string;
  phone: string;
  firstName: string;
  lastName: string;
  email: string | null;
  profileComplete: boolean;
  roles: string[];
  driver: null | {
    id: string;
    verificationStatus: string;
    activeVehicleId: string | null;
    ratingAvg: string;
    tripsCompleted: number;
  };
  passenger: null | { id: string; ratingAvg: string; tripsCompleted: number };
}

// ---------- drivers ----------

export const DriverOnboardBody = z.object({
  cityKey: z.string().default("abuja"),
  licenceNumber: z.string().trim().min(5).max(30),
  licenceExpiresAt: z.string().date(),
  addressLine: z.string().trim().min(5).max(200),
});
export type DriverOnboardBody = z.infer<typeof DriverOnboardBody>;

export const VehicleBody = z.object({
  categoryKey: z.string(),
  make: z.string().trim().min(2).max(40),
  model: z.string().trim().min(1).max(40),
  year: z.number().int().min(1990).max(2100),
  colour: z.string().trim().min(3).max(30),
  plateNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}[- ]?\d{2,3}[- ]?[A-Z]{2}$/, "Plate must look like ABC 123 DE"),
});
export type VehicleBody = z.infer<typeof VehicleBody>;

export const GoOnlineBody = latLng;

export const LocationPoint = latLng.extend({
  heading: z.number().min(0).max(360).optional(),
  speedKmh: z.number().min(0).max(300).optional(),
  accuracyM: z.number().min(0).max(5000).optional(),
  recordedAt: z.string().datetime(),
  clientSeq: z.number().int().nonnegative(),
});
export type LocationPoint = z.infer<typeof LocationPoint>;

// ---------- rides ----------

export const EstimateBody = z.object({
  pickup: place,
  dropoff: place,
  categoryKey: z.string().optional(),
});
export type EstimateBody = z.infer<typeof EstimateBody>;

export interface CategoryEstimate {
  categoryKey: string;
  name: string;
  seats: number;
  suggestedFare: string;
  minFare: string;
  maxFare: string;
}

export interface EstimateResponse {
  distanceM: number;
  durationS: number;
  polyline: string | null;
  serviceAreaId: string;
  categories: CategoryEstimate[];
}

export const CreateRideRequestBody = z.object({
  pickup: place,
  dropoff: place,
  categoryKey: z.string(),
  proposedFare: kobo,
  paymentMethod: PaymentMethodType,
  note: z.string().max(200).optional(),
});
export type CreateRideRequestBody = z.infer<typeof CreateRideRequestBody>;

export const RaiseFareBody = z.object({ proposedFare: kobo });

export const CreateOfferBody = z.union([
  z.object({ acceptPassengerPrice: z.literal(true) }),
  z.object({ amount: kobo }),
]);
export type CreateOfferBody = z.infer<typeof CreateOfferBody>;

export const CancelBody = z.object({
  reasonCode: z.enum([
    "CHANGED_PLANS", "DRIVER_TOO_FAR", "DRIVER_ASKED_TO_CANCEL", "WAIT_TOO_LONG", "FOUND_OTHER_RIDE",
    "PASSENGER_NO_SHOW", "PASSENGER_UNREACHABLE", "UNSAFE", "VEHICLE_ISSUE", "OTHER",
  ]),
  reasonText: z.string().max(300).optional(),
});
export type CancelBody = z.infer<typeof CancelBody>;

export const StartTripBody = z.object({ pin: z.string().regex(/^\d{4}$/) });
export const CompleteTripBody = latLng;

export const RateBody = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
  tags: z.array(z.string().max(30)).max(6).optional(),
});
export type RateBody = z.infer<typeof RateBody>;

export interface OfferView {
  id: string;
  amount: string;
  isPassengerPrice: boolean;
  status: string;
  revision: number;
  etaToPickupS: number | null;
  distanceToPickupM: number | null;
  expiresAt: string;
  driver: { firstName: string; ratingAvg: string; tripsCompleted: number };
  vehicle: { make: string; model: string; colour: string; categoryKey: string };
}

export interface RideRequestView {
  id: string;
  code: string;
  status: RideStatus;
  pickup: Place;
  dropoff: Place;
  categoryKey: string;
  distanceM: number;
  durationS: number;
  suggestedFare: string;
  proposedFare: string;
  minFare: string;
  maxFare: string;
  paymentMethod: PaymentMethodType;
  expiresAt: string;
  offers: OfferView[];
  rideId: string | null;
}

export interface DriverRequestView {
  requestId: string;
  code: string;
  pickup: { area: string; lat: number; lng: number };
  dropoffArea: string;
  distanceM: number;
  durationS: number;
  distanceToPickupM: number | null;
  proposedFare: string;
  maxCounter: string;
  categoryKey: string;
  paymentMethod: PaymentMethodType;
  passenger: { firstName: string; ratingAvg: string };
  expiresAt: string;
  myOffer: null | { id: string; amount: string; status: string };
}

export interface RideView {
  id: string;
  code: string;
  status: RideStatus;
  version: number;
  agreedFare: string;
  finalFare: string | null;
  commissionAmount: string | null;
  paymentMethod: PaymentMethodType;
  pickup: Place;
  dropoff: Place;
  distanceM: number;
  durationS: number;
  passenger: { firstName: string; ratingAvg: string; phoneMasked: string };
  driver: { firstName: string; ratingAvg: string; tripsCompleted: number; lat: number | null; lng: number | null };
  vehicle: { make: string; model: string; colour: string; plateNumber: string; categoryKey: string };
  tripPin: string | null; // only included for the passenger, until the trip starts
  assignedAt: string;
  arrivedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  myRating: number | null;
  shareToken: string | null;
}

export interface WalletView {
  ownerType: "PASSENGER" | "DRIVER";
  availableBalance: string;
  pendingBalance: string;
  heldBalance: string;
  negativeLimit: string;
}

export interface EarningsView {
  period: "day" | "week" | "month";
  trips: number;
  gross: string;
  commission: string;
  net: string;
  cashCollected: string;
}

// ---------- errors ----------

export const ErrorCode = z.enum([
  "VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "RATE_LIMITED",
  "OTP_INVALID", "OTP_EXPIRED", "OTP_ATTEMPTS_EXCEEDED", "TOKEN_REUSED", "PROFILE_INCOMPLETE",
  "IDEMPOTENCY_KEY_REQUIRED", "IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_IN_PROGRESS",
  "OUTSIDE_SERVICE_AREA", "CATEGORY_UNAVAILABLE", "FARE_BELOW_MINIMUM", "FARE_ABOVE_MAXIMUM",
  "FARE_BELOW_PER_KM_FLOOR", "ACTIVE_REQUEST_EXISTS", "WALLET_INSUFFICIENT",
  "REQUEST_CLOSED", "OFFER_EXPIRED", "COUNTER_OFFER_OUT_OF_RANGE", "DRIVER_NOT_ELIGIBLE",
  "DRIVER_NO_LONGER_AVAILABLE", "INVALID_STATE_TRANSITION", "RIDE_STATE_CHANGED",
  "INVALID_TRIP_PIN", "PIN_ATTEMPTS_EXCEEDED", "TOO_FAR_FROM_PICKUP", "ALREADY_RATED",
  "DRIVER_NOT_VERIFIED", "NO_ACTIVE_VEHICLE", "DRIVER_SUSPENDED", "WALLET_LIMIT_EXCEEDED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export interface ApiError {
  error: { code: ErrorCode; message: string; details?: unknown; requestId?: string };
}

// ---------- socket events (server → client) ----------

export interface ServerEvent<T = unknown> {
  eventId: string;
  type: string;
  sentAt: string;
  data: T;
}

export const SocketEvents = {
  RideRequestNew: "ride_request.new",
  RideRequestUpdated: "ride_request.updated",
  RideRequestClosed: "ride_request.closed",
  OfferUpserted: "offer.upserted",
  OfferWithdrawn: "offer.withdrawn",
  OfferResult: "offer.result",
  RequestStatus: "ride_request.status",
  RideAssigned: "ride.assigned",
  RideStatus: "ride.status",
  RideDriverLocation: "ride.driver_location",
  DriverForcedOffline: "driver.forced_offline",
  // client → server
  DriverHeartbeat: "driver.heartbeat",
  DriverLocation: "driver.location",
} as const;
