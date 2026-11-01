# API Contracts — v1

Base URL `https://api.<domain>/v1` · JSON · Swagger at `/v1/docs` (staging only, admin-auth in prod).
The source of truth for request/response shapes is `packages/contracts` (Zod). This document is the human index and the agreed behaviour; Swagger is generated from the same schemas.

## 1. Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <accessJwt>`. Token carries `sub`, `scope` (`PASSENGER`/`DRIVER`/`ADMIN`), `perms` hash, `sid`. A passenger token cannot call driver routes and vice versa, even for the same user. |
| Idempotency | All `POST`/`PATCH` that create or change rides, offers, payments, wallets or withdrawals **require** `Idempotency-Key: <uuid v4>`. Same key + same body within 24 h returns the stored response; same key + different body → `422 IDEMPOTENCY_KEY_REUSED`. |
| Money | Strings of kobo: `"fare": "250000"` = ₦2,500.00. Currency is implicit per city (`NGN`). |
| Time | ISO-8601 UTC strings. |
| IDs | opaque strings; human refs (`code`, `reference`, `number`) for display/support. |
| Pagination | cursor: `?limit=20&cursor=<opaque>` → `{ data: [...], nextCursor: string|null }`. |
| Filtering (admin) | `?q=&status=&cityId=&from=&to=&sort=createdAt:desc`. |
| Errors | `{ "error": { "code": "OFFER_EXPIRED", "message": "human text", "details": {...}, "requestId": "..." } }` with correct HTTP status. Codes are a closed enum in `contracts/errors.ts`; apps switch on `code`, never on `message`. |
| Rate limits | 429 with `Retry-After`. OTP send: 3/phone/10 min, 10/IP/hour. Offers: 10/driver/min. Location over REST fallback: 1/2 s. |
| Versioning | URI (`/v1`). Breaking changes → `/v2`; mobile apps send `X-App-Version`; server can return `426 APP_UPDATE_REQUIRED`. |

## 2. Auth — `AuthModule`

| Method | Path | Body → Response | Notes |
|---|---|---|---|
| POST | `/auth/otp/request` | `{phone, purpose, appScope}` → `{otpId, expiresAt, resendAfter}` | phone in E.164; NG numbers normalised from `080…` |
| POST | `/auth/otp/verify` | `{otpId, code, device:{installId, platform, model, appVersion}}` → `{accessToken, refreshToken, user, isNewUser}` | creates user on first verify (SIGNUP) |
| POST | `/auth/register` | `{firstName, lastName, email?, referralCode?, termsVersion, marketingConsent}` → `{user}` | completes profile after first OTP |
| POST | `/auth/login/password` | `{phoneOrEmail, password}` → tokens | optional path |
| POST | `/auth/refresh` | `{refreshToken}` → `{accessToken, refreshToken}` | rotation; reuse → `401 TOKEN_REUSED`, family revoked |
| POST | `/auth/logout` | — | revokes current session |
| POST | `/auth/logout-all` | — | revokes all sessions |
| POST | `/auth/password/forgot` · `/auth/password/reset` | OTP-based | |
| POST | `/auth/admin/login` | `{email, password}` → `{mfaToken}` | |
| POST | `/auth/admin/mfa/verify` | `{mfaToken, totp}` → tokens | |
| POST | `/auth/admin/mfa/setup` · `/confirm` | TOTP enrolment, returns recovery codes once | |

## 3. Users & profile — `UsersModule`, `PassengersModule`, `LocationsModule`

| Method | Path | Purpose |
|---|---|---|
| GET/PATCH | `/me` | profile, locale, avatar (`avatarFileId` from Files) |
| POST | `/me/phone/change` | OTP to new number then verify |
| GET/POST/PATCH/DELETE | `/me/emergency-contacts[/:id]` | |
| GET/POST/PATCH/DELETE | `/me/saved-places[/:id]` | home/work/custom |
| GET/PUT | `/me/notification-preferences` | SAFETY category not disableable |
| POST/DELETE | `/me/push-tokens` | register Expo push token |
| GET | `/me/sessions` · DELETE `/me/sessions/:id` | device management |
| POST | `/me/deletion-request` | starts 30-day deletion; `DELETE` cancels |
| GET | `/me/data-export` | NDPA access request (async; emailed link) |
| GET | `/passenger/home` | aggregated: wallet balance, recent destinations, banners, active ride if any |

## 4. Maps — `MapsModule` (server-side proxy; keeps billing keys off devices)

| Method | Path | Notes |
|---|---|---|
| GET | `/maps/autocomplete?input=&sessionToken=&lat=&lng=` | Places Autocomplete, biased to city; session tokens for billing |
| GET | `/maps/place/:placeId?sessionToken=` | details → lat/lng |
| GET | `/maps/reverse-geocode?lat=&lng=` | |
| POST | `/maps/route` | `{origin, destination, waypoints?}` → `{distanceM, durationS, polyline}` |
| GET | `/maps/nearby-drivers?lat=&lng=&category=` | count + coarse, jittered positions for the home map (no IDs) |
| GET | `/cities/resolve?lat=&lng=` | city + service area + enabled categories, or `422 OUTSIDE_SERVICE_AREA` |

Map tiles render on-device with a restricted public key.

## 5. Ride requests & negotiation — `RidesModule`, `FareNegotiationModule`

| Method | Path | Actor | Body → Response |
|---|---|---|---|
| POST | `/ride-requests/estimate` | P | `{pickup, dropoff, categoryKey}` → `{distanceM, durationS, suggestedFare, minFare, maxFare, polyline}` |
| POST | `/ride-requests` | P | see below → `201 RideRequest` |
| GET | `/ride-requests/:id` | P | request + current offers |
| PATCH | `/ride-requests/:id/fare` | P | `{proposedFare}` raise fare → re-broadcast |
| POST | `/ride-requests/:id/cancel` | P | `{reasonCode}` |
| GET | `/driver/ride-requests` | D | requests currently dispatched to me (for app resume) |
| POST | `/ride-requests/:id/offers` | D | `{amount}` or `{acceptPassengerPrice:true}` → `RideOffer` |
| PATCH | `/ride-requests/:id/offers/mine` | D | `{amount}` update before acceptance |
| DELETE | `/ride-requests/:id/offers/mine` | D | withdraw |
| POST | `/ride-requests/:id/decline` | D | hides it, feeds acceptance rate |
| POST | `/ride-requests/:id/offers/:offerId/accept` | P | → `200 Ride` (atomic, see ARCHITECTURE §3.2) |
| POST | `/ride-requests/:id/offers/:offerId/reject` | P | |

```jsonc
// POST /v1/ride-requests   (Idempotency-Key required)
{
  "pickup":  { "lat": 9.0579, "lng": 7.4951, "address": "Wuse 2, Abuja", "placeId": "..." },
  "dropoff": { "lat": 9.0068, "lng": 7.2632, "address": "Nnamdi Azikiwe Airport", "placeId": "..." },
  "stops": [],
  "categoryKey": "economy",
  "proposedFare": "650000",
  "paymentMethod": "CASH",        // CASH | WALLET | CARD
  "paymentMethodId": null,        // required for CARD
  "promoCode": null,
  "note": "At the main gate"
}
// 201
{
  "id": "clx...", "code": "R-7K2QX9", "status": "SEARCHING",
  "distanceM": 38210, "durationS": 2460,
  "suggestedFare": "720000", "proposedFare": "650000",
  "expiresAt": "2026-11-02T08:03:00Z"
}
```

Validation errors (all `422`): `FARE_BELOW_MINIMUM`, `FARE_ABOVE_MAXIMUM`, `FARE_BELOW_PER_KM_FLOOR`, `OUTSIDE_SERVICE_AREA`, `CATEGORY_UNAVAILABLE`, `ACTIVE_REQUEST_EXISTS` (409), `WALLET_INSUFFICIENT`, `PROMO_INVALID`.
Offer errors: `REQUEST_CLOSED` (409), `OFFER_EXPIRED` (409), `COUNTER_OFFER_OUT_OF_RANGE` (422), `DRIVER_NOT_ELIGIBLE` (403), `DRIVER_NO_LONGER_AVAILABLE` (409).

## 6. Trips — `RidesModule`, `TripTrackingModule`

| Method | Path | Actor | Transition / purpose |
|---|---|---|---|
| GET | `/rides/active` | P/D | current ride or 204 (app resume) |
| GET | `/rides/:id` | P/D/A | role-filtered view |
| GET | `/rides/:id/sync?afterSeq=` | P/D | missed socket events after reconnect |
| POST | `/rides/:id/en-route` | D | DRIVER_SELECTED → DRIVER_EN_ROUTE |
| POST | `/rides/:id/arrived` | D | → DRIVER_ARRIVED (server checks distance to pickup) |
| POST | `/rides/:id/start` | D | `{pin}` → TRIP_STARTED; `INVALID_TRIP_PIN`, `PIN_ATTEMPTS_EXCEEDED` |
| POST | `/rides/:id/complete` | D | `{endLat, endLng}` → TRIP_COMPLETED; triggers payment + commission |
| POST | `/rides/:id/cash-collected` | D | confirms cash received |
| POST | `/rides/:id/cancel` | P/D | `{reasonCode, text?}` → fee computed server-side and returned |
| POST | `/rides/:id/locations` | D | batch fallback `{points:[{lat,lng,heading,speed,accuracy,recordedAt,clientSeq}]}` |
| POST | `/rides/:id/share` | P | → `{url}` public live-trip link (token, expires at completion) |
| GET | `/public/trips/:shareToken` | none | masked live view (first names, vehicle, position) |
| POST | `/rides/:id/ratings` | P/D | `{stars, comment?, tags?, anonymous?}` |
| POST | `/ratings/:id/report` | P/D | |
| GET | `/rides?role=passenger|driver&status=&cursor=` | P/D | history |
| GET | `/rides/:id/receipt` | P | receipt JSON + signed PDF URL |

Illegal transitions → `409 INVALID_STATE_TRANSITION` with `{from, attempted}`; stale version → `409 RIDE_STATE_CHANGED` (client refetches).

## 7. Drivers — `DriversModule`, `DriverVerificationModule`, `VehiclesModule`

| Method | Path | Purpose |
|---|---|---|
| POST | `/driver/onboarding` | create Driver for current user (cityId, personal info) |
| GET | `/driver/me` | driver profile + verification checklist + doc statuses |
| POST | `/driver/documents` | `{type, fileId, documentNumber?, issuedAt?, expiresAt?}` |
| POST/PATCH | `/driver/vehicles[/:id]` | add / edit vehicle |
| POST | `/driver/vehicles/:id/documents` | |
| PUT | `/driver/vehicles/:id/active` | set active vehicle (must be APPROVED) |
| PUT | `/driver/bank-account` | `{bankCode, accountNumber}` → resolves name via provider, stores recipient code + last4 only |
| GET | `/banks` | provider bank list |
| POST | `/driver/availability/online` | `{lat, lng}` → checks verified, not suspended, docs valid, wallet above negative limit, inside service area |
| POST | `/driver/availability/offline` | |
| GET | `/driver/earnings?period=day|week|month&from=` | gross, commission, net, cash collected, trips |
| GET | `/driver/statements?month=` | PDF statement |

## 8. Files — `FilesModule`

| Method | Path | Notes |
|---|---|---|
| POST | `/files/upload-url` | `{purpose, mimeType, sizeBytes, sha256}` → `{fileId, uploadUrl, headers, expiresAt}`; allowed types per purpose (images/PDF), max 10 MB |
| POST | `/files/:id/complete` | server HEADs object, checks size/hash/magic bytes, queues scan |
| GET | `/files/:id/url` | 5-min signed GET, only if caller may see it |

## 9. Payments & wallet — `PaymentsModule`, `WalletModule`, `WithdrawalsModule`

| Method | Path | Actor | Notes |
|---|---|---|---|
| GET | `/wallet` | P/D | balances (available, pending, held) |
| GET | `/wallet/transactions?cursor=` | P/D | statement lines |
| POST | `/wallet/topups` | P/D | `{amount, provider}` → `{reference, authorizationUrl | checkoutLink}`; status stays PENDING until webhook/verify |
| GET | `/payments/:reference` | P/D | status polling after returning from checkout |
| GET/DELETE | `/payment-methods[/:id]` | P | saved cards (tokenised by provider) |
| POST | `/payment-methods/cards/init` | P | ₦50 authorisation charge (refunded) to save a card |
| POST | `/withdrawals` | D (P if enabled) | `{amount}` → holds funds |
| GET | `/withdrawals` | D | history |
| POST | `/webhooks/paystack` | provider | raw body, `x-paystack-signature` |
| POST | `/webhooks/flutterwave` | provider | `verif-hash` |

Errors: `WALLET_FROZEN`, `WALLET_INSUFFICIENT`, `WITHDRAWAL_BELOW_MINIMUM`, `BANK_ACCOUNT_MISSING`, `PAYMENT_PROVIDER_ERROR` (502).

## 10. Messaging, notifications, support, safety

| Method | Path | Notes |
|---|---|---|
| GET | `/conversations/:id/messages?cursor=` | ride chat history |
| POST | `/conversations/:id/messages` | `{clientMessageId, type, body?, attachmentId?}`; phone numbers/links masked; closed 2 h after trip |
| POST | `/conversations/:id/read` | `{lastReadMessageId}` |
| GET | `/notifications?cursor=` · POST `/notifications/read` | in-app inbox |
| GET/POST | `/support/tickets` | create with `{category, rideId?, subject, body, attachmentIds}` |
| GET/POST | `/support/tickets/:id/messages` | |
| POST | `/rides/:id/disputes` | `{reason, amount?, attachmentIds}` within dispute window |
| POST | `/safety/sos` | `{rideId?, lat, lng}` → `{incidentId, emergencyNumbers, contactsNotified: n}` |
| POST | `/safety/reports` | unsafe driver/passenger report |
| GET | `/promotions/banners` | home banners for city |
| POST | `/promo-codes/validate` | `{code, categoryKey, fare}` → discount preview |
| GET | `/referrals/me` | code, link, referrals, rewards |

## 11. Admin — `/admin/*` (permission per route)

| Area | Endpoints (all list routes support filters + CSV/XLSX export via `?format=csv|xlsx`) | Permission |
|---|---|---|
| Dashboard | `GET /admin/metrics/overview?cityId=&from=&to=&compare=prev` · `/admin/metrics/timeseries?metric=bookings|revenue|commission&interval=day` | `dashboard:read` |
| Passengers | `GET /admin/passengers` · `/:id` · `/:id/rides` · `/:id/payments` · `POST /:id/suspend` · `/:id/reactivate` | `passengers:read|write` |
| Drivers | `GET /admin/drivers?verification=` · `/:id` · `POST /:id/suspend|reactivate|blacklist` · `GET /:id/earnings` | `drivers:read|write` |
| Verification | `GET /admin/verification/queue` · `POST /admin/driver-documents/:id/approve|reject` · `POST /admin/vehicle-documents/:id/approve|reject` · `POST /admin/vehicles/:id/approve|reject` · `POST /admin/drivers/:id/verification` `{toStatus, notes, checklist}` | `drivers:verify` |
| Live ops | `GET /admin/live/snapshot?cityId=` (drivers + active rides) then socket room `admin:ops:{cityId}` | `ops:live` |
| Rides | `GET /admin/rides?status=` · `/:id` (incl. negotiation timeline, status history, breadcrumbs, payments) · `POST /:id/cancel` · `POST /:id/override-pin` · `POST /:id/flag-dispute` | `rides:read|write` |
| Pricing | `GET /admin/pricing?areaId=&category=` · `POST /admin/pricing` (creates new version, `changeReason` required) · `GET /admin/pricing/:id/history` | `pricing:write` |
| Cities & areas | CRUD `/admin/cities` · `/admin/service-areas` (GeoJSON boundary) · `/admin/vehicle-categories` · `PUT /admin/cities/:id/categories` | `config:write` |
| Finance | `GET /admin/finance/summary` · `/ledger/accounts` · `/ledger/transactions` · `/payments` · `/webhooks?status=UNMATCHED` · `/settlements` · `POST /settlements/:id/reconcile` | `finance:read` |
| Refunds | `GET /admin/refunds` · `POST /admin/payments/:id/refunds` `{amount, reason, destination}` · `POST /admin/refunds/:id/approve|reject` | `finance:refund` |
| Withdrawals | `GET /admin/withdrawals?status=` · `POST /:id/approve|reject` | `finance:payout` |
| Adjustments | `POST /admin/wallets/:id/adjustments` `{amount, direction, reason}` — creates ADJUSTMENT ledger txn, dual-approval above threshold | `finance:adjust` |
| Promotions | CRUD `/admin/promotions` · `/admin/promo-codes` · `GET /admin/referrals?status=` · `POST /admin/referrals/:id/reject` | `marketing:write` |
| Support | `GET /admin/tickets?status=&assignee=` · `POST /:id/assign` · `/:id/messages` (internal notes) · `/:id/resolve` | `support:write` |
| Disputes | `GET /admin/disputes` · `POST /:id/resolve` `{outcome, refundAmount?, notes}` | `disputes:write` |
| Safety | `GET /admin/safety/incidents` · `POST /:id/acknowledge` · `/:id/escalation` `{note}` (records a real external contact) · `/:id/resolve` | `safety:write` |
| Notifications | CRUD `/admin/notification-templates` · `POST /admin/campaigns` · `/:id/send` | `notifications:send` |
| Settings | `GET/PUT /admin/settings/:key` | `config:write` |
| Admins & roles | CRUD `/admin/admins` · `/admin/roles` · `PUT /admin/admins/:id/roles` | `rbac:write` |
| Audit | `GET /admin/audit-logs?entity=&entityId=` · `/admin/action-logs` | `audit:read` |

## 12. WebSocket events

Namespace `/rt`. Handshake: `io(url, { auth: { token } })`. Envelope for every server → client event:

```ts
{ eventId: string; seq: number; type: string; sentAt: string; data: T }
```

### Server → client

| Event | Room | Data |
|---|---|---|
| `ride_request.new` | `driver:{id}` | `{requestId, pickup:{area, lat, lng}, dropoff:{area}, distanceM, durationS, distanceToPickupM, proposedFare, categoryKey, passenger:{firstName, rating}, paymentMethod, expiresAt}` |
| `ride_request.updated` | `driver:{id}` | fare raised / still open |
| `ride_request.closed` | `driver:{id}` | `{requestId, reason: ASSIGNED_OTHER|CANCELLED|EXPIRED}` |
| `offer.upserted` | `user:{passengerUserId}` | `{offer:{id, amount, isPassengerPrice, etaToPickupS, revision, expiresAt}, driver:{firstName, rating, trips, photoUrl}, vehicle:{make, model, colour}}` — plate shown only after acceptance |
| `offer.withdrawn` / `offer.expired` | `user:{passengerUserId}` | `{offerId}` |
| `offer.result` | `driver:{id}` | `{offerId, result: ACCEPTED|REJECTED}` |
| `ride.assigned` | `driver:{id}` | full ride for driver |
| `ride.status` | `ride:{id}` | `{rideId, status, at, version}` |
| `ride.driver_location` | `ride:{id}` (passenger) | `{lat, lng, heading, etaS?, at}` |
| `ride.fare_finalised` | `ride:{id}` | `{finalFare, breakdown}` |
| `payment.status` | `user:{id}` | `{reference, status}` |
| `chat.message` / `chat.read` / `chat.typing` | `ride:{id}` | |
| `notification.new` | `user:{id}` | inbox item |
| `driver.forced_offline` | `driver:{id}` | `{reason: HEARTBEAT_LOST|SUSPENDED|DOC_EXPIRED|WALLET_LIMIT}` |
| `admin.ops.driver` | `admin:ops:{cityId}` | `{driverId, lat, lng, status, categoryKey}` (throttled 5 s) |
| `admin.ops.ride` | `admin:ops:{cityId}` | ride status changes |
| `admin.safety.incident` | `admin:ops:{cityId}` | SOS alerts (also push/SMS to on-call) |

### Client → server

| Event | From | Data | Ack |
|---|---|---|---|
| `driver.heartbeat` | D | `{lat, lng, battery?, appState}` every 15 s | `{ok}` |
| `driver.location` | D | `{lat, lng, heading, speed, accuracy, recordedAt, rideId?, clientSeq}` | none (throttled) |
| `chat.typing` | P/D | `{conversationId}` | none |
| `room.resync` | any | `{room, lastSeq}` | missed events or `RESYNC_VIA_REST` |
| `admin.ops.subscribe` | A | `{cityId}` | permission-checked |

## 13. Health & ops

`GET /health/live`, `GET /health/ready` (DB + Redis + queue), `GET /metrics` (Prometheus, internal network only).
