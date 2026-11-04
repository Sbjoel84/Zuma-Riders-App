# Zuma

Fare-negotiation ride-hailing for Nigeria, launching in Abuja. The passenger offers a price, nearby drivers accept it or counter, and the passenger picks a driver.

| App | Path | Stack |
|---|---|---|
| API (REST + Socket.IO + jobs) | `apps/api` | NestJS 11, Prisma 7, PostgreSQL + PostGIS, Redis, BullMQ |
| Passenger app | `apps/passenger` | Expo SDK 58, Expo Router, React Native Maps |
| Driver app | `apps/driver` | Expo SDK 58, background location |
| Admin dashboard | `apps/admin` | React 19, Vite, Tailwind CSS 4, TanStack Query, Recharts, Leaflet |
| Shared | `packages/contracts`, `packages/mobile-core`, `packages/database` | Zod contracts, API/socket client + UI kit, Prisma schema and migrations |

## What works today (ride slice)

The full loop between the two apps and the API works:

1. **Sign in** with phone number and SMS code (refresh tokens rotate; a reused token signs the device out).
2. **Driver onboarding:** licence details and vehicle, then approval.
3. **Going online.** The driver app sends location in the background with a foreground-service notification on Android. If the heartbeat stops, the driver is taken offline.
4. **Booking.** The passenger searches a destination and gets fares from versioned pricing rules for each service area. They offer their own price within the minimum and maximum, and pay by cash or wallet.
5. **Negotiation.** The request goes to ranked nearby drivers, and the search radius widens if few respond. Drivers accept the price or counter-offer. The passenger compares live offers, raises the fare or cancels.
6. **Acceptance** is atomic: one ride per request, one live ride per driver, and the fare is locked at the database level.
7. **The trip:** en route → arrived (checked against distance from pickup) → start with the passenger's 4-digit PIN → complete. The passenger sees the driver move live on the map.
8. **Settlement** goes through a double-entry ledger:
   - Cash trips book the commission the driver owes.
   - Wallet trips pay the driver into a pending balance, which is released after a 24-hour hold.
9. **Ratings** both ways, and driver earnings for the day, week or month.
10. **Admin dashboard** (web), signed in with an SMS code; each staff role only sees what it is allowed to:
    - **Overview:** live figures, completed rides by hour and over 7 days, and a "needs attention" list.
    - **Live map:** online drivers, open requests and trips in progress, every 5 seconds.
    - **Rides:** search and filter; each ride shows the full negotiation, status history, route breadcrumbs and ledger entries; cancel or flag a dispute (reason required).
    - **Drivers, Verification, Passengers:** search, suspend and reactivate; approve or reject drivers and each vehicle.
    - **Finance:** bookings, commission, cash commission owed, wallet liabilities, a live ledger integrity check, manual driver payouts (approve → send transfer → mark paid with bank reference), audited wallet adjustments, and the ledger journal with CSV export.
    - **Pricing:** publish a new pricing version per area and category; old versions are kept and shown in history.
    - **Support:** tickets from both apps, replies, internal notes (hidden from customers), assignment, resolve and reopen.
    - **Safety:** SOS alerts and safety reports with location and timeline; acknowledge, record a real contact with emergency services, resolve or mark false alarm.
    - **Settings:** service areas (status, search radius), vehicle categories per city, admins and roles, and the audit log of actions and configuration changes.
11. **App extras:** SOS alerts the Zuma safety team with the rider's location; "Report a problem" after any trip; the driver app has a wallet screen with earnings, bank account and withdrawal requests.

**Not built yet:**
- Card payments, Paystack/Flutterwave wallet top-ups and automatic bank transfers (payouts are manual for now)
- Document photo uploads (verification is done in person at the driver hub)
- Push notifications and in-app chat
- SMS to a rider's emergency contacts on SOS (the Zuma ops team is alerted; riders see 112 and 199 to call)
- Promo codes and referral rewards
- Two-factor (authenticator app) sign-in for admins: admins currently sign in with an SMS code

## Run it locally

You need Node 22, pnpm 9 and Docker (or a local PostgreSQL 16 with PostGIS, plus Redis 7).

```bash
pnpm install
docker compose up -d                      # Postgres+PostGIS on 5432, Redis on 6379

cp packages/database/.env.example packages/database/.env   # point both URLs at localhost
cp apps/api/.env.example apps/api/.env                     # then set the three secrets: openssl rand -hex 32
pnpm --filter @zuma/database generate
pnpm --filter @zuma/database build && pnpm --filter @zuma/contracts build
pnpm db:migrate
SEED_ADMIN_PHONE=+2348000000001 pnpm db:seed               # Abuja, categories, pricing v1, roles, an admin

pnpm api:dev                              # http://localhost:4000, OTP codes print in this terminal

cp apps/admin/.env.example apps/admin/.env.local
pnpm admin                                # http://localhost:5173, sign in with 0800 000 0001
```

To see the dashboard with realistic activity on a **local** database, run `pnpm demo-data`. It drives the real API: 11 drivers register (8 approved and online), 10 passengers book and negotiate, trips run to completion, payouts, tickets and an SOS are raised. It refuses to run against a non-local database. Add `--keepalive 30` to keep the demo drivers online for 30 minutes, or run `pnpm --filter @zuma/api demo-data --online-only 30` later to bring them back online without new activity.

In development the API uses `SMS_PROVIDER=console`, so sign-in codes are printed in the API terminal. It also uses `MAPS_PROVIDER=estimate`: a list of Abuja places for search and straight-line × 1.35 for distances. The API refuses both settings when `NODE_ENV=production`.

### Run the apps on a phone

The apps use native modules (maps, background location, secure storage), so they need a development build, not Expo Go.

```bash
cd apps/passenger && cp .env.example .env    # EXPO_PUBLIC_API_URL=http://<your-computer's-LAN-IP>:4000
npx expo run:android                          # or: npx eas build --profile development --platform android
# same for apps/driver
```

To test a full trip with one computer and two phones (or one phone and an emulator):

1. Driver app: sign in, complete the details and vehicle steps.
2. Approve the driver and their vehicle in the dashboard under **Verification** (or run `pnpm approve-driver 0803 123 4567`).
3. Driver app: **Go online** from somewhere inside Abuja. In an emulator, set the GPS location to Wuse 2 (9.0765, 7.4790).
4. Passenger app: sign in, search "Jabi" or "Airport", pick a fare and tap **Find drivers**.
5. Driver: accept or counter. Passenger: accept the offer, read out the PIN. Driver: arrived → enter PIN → complete.

## Tests

```bash
pnpm api:test        # 35 tests against real Postgres+PostGIS and Redis (uses the zuma_test database)
```

The tests cover:
- the trip state machine, for every state, event and actor;
- fare bounds and rounding, commission and phone normalisation;
- the brief's 20-step journey end to end over REST and Socket.IO;
- 10 concurrent accepts producing exactly one ride, and two passengers accepting the same driver at the same moment;
- duplicate submits, refresh-token reuse, request expiry, and unverified drivers being blocked;
- wallet settlement and the pending → available release;
- place search;
- every admin flow: metrics, live map, suspensions, verification, payouts through the ledger, pricing versions, area and category changes, the support desk, the SOS escalation rules, and role permissions;
- sign-in rate limits.

CI (`.github/workflows/ci.yml`) runs the API tests with PostGIS and Redis service containers, typechecks and bundles both apps for Android and iOS, and builds the admin dashboard.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): system design, ride lifecycle, matching, money, security
- [docs/DECISIONS.md](docs/DECISIONS.md): architecture decision records
- [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md): REST and WebSocket contracts (the full target API; the ride slice implements the auth, driver, ride, wallet-read and admin-driver parts)
- [docs/STANDARDS.md](docs/STANDARDS.md): coding, testing and done criteria

## Decisions needed from the owner

1. Brand name and domain (bundle IDs are `com.zuma.passenger` / `com.zuma.driver` for now).
2. Commission rate per category (seeded at 15%), and whether cash trips use the same rate.
3. How much cash commission a driver may owe before being blocked from going online (₦5,000 for now).
4. Motorcycle and tricycle categories in the FCT: they are off pending a legal review.
5. SMS provider (Termii is wired in) and whether to mask phone calls between rider and driver.
6. Hosting for the API (Railway or Fly.io) and Redis (needs keyspace notifications).
7. Payout hold time (24 h now), minimum withdrawal, and who pays transfer fees.
8. Whether passengers can withdraw wallet balances (affects the licensing position with the CBN).
9. Data retention periods and DPO contact, for NDPA compliance.
10. SOS procedure, and whether ops staff the safety queue 24/7 at launch.

## Accounts and keys needed next

Neon (PostGIS enabled), Redis Cloud, API hosting, Google Maps Platform (Places, Routes, Geocoding, and the Maps SDK for Android/iOS), Termii, Expo/EAS, Apple Developer Program, Google Play Console, Paystack and Flutterwave (test keys first), Sentry, and object storage for documents.
