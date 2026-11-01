# Architecture Decision Records

Short ADRs. Each: context → decision → consequence. New decisions get appended, never edited away; superseded ones are marked.

---

### ADR-001 Money as integer kobo (`BigInt`)
**Decision:** all amounts stored as `BigInt` minor units. Percentages as basis points (`Int`, 1500 = 15%). Rounding: commission = `floor(fare × bps / 10000)`; the remainder stays with the driver.
**Why:** floats lose precision; `Decimal` works but invites mixing with JS numbers. Integers make ledger balancing exact.
**Consequence:** Prisma returns `bigint`; the API serializes money as **strings** in JSON (`"250000"`) to avoid JS number overflow assumptions; `packages/contracts` exports `Money` helpers.

### ADR-002 Merge `Driver` and `DriverProfile`
**Context:** the brief lists both. Rule 10 forbids duplicate entities.
**Decision:** one `Driver` table, 1:1 with `User`. Same pattern for passengers (`PassengerProfile`) and admins (`AdminProfile`).

### ADR-003 `Ride` creation *is* the `RideAssignment`
**Context:** the brief lists `RideRequest`, `RideAssignment` and `Ride` and requires "one RideRequest → only one confirmed assignment".
**Decision:** no separate assignment table. A `Ride` row is inserted at acceptance with `rideRequestId @unique` and `acceptedOfferId @unique`, plus a partial unique index on active rides per driver. The insert is the lock.
**Why:** a separate table would duplicate driver/passenger/fare columns and need its own sync with `Ride`. The unique constraints give a database-level guarantee that survives application bugs.
**Consequence:** `RideRequest` holds negotiation state (REQUESTED…OFFERS_RECEIVED/EXPIRED/CANCELLED); `Ride` holds trip state (DRIVER_SELECTED onward). Both use one `RideStatus` enum so clients render a single timeline.

### ADR-004 One live offer per driver per request
**Decision:** `RideOffer @@unique([rideRequestId, driverId])`; updating an offer bumps `revision`. Every change is also appended to `FareNegotiation` (immutable), which is the full negotiation history admins inspect.
**Why:** the passenger compares current offers, not a growing list of stale ones; history is still complete.

### ADR-005 Pricing is versioned, rides snapshot it
**Decision:** `PricingConfiguration` rows are never edited. A change inserts version N+1 and closes N (`effectiveTo`). `RideRequest.pricingConfigId` and `Ride.commissionBps` snapshot the rules in force.
**Why:** a mid-day commission change must not alter rides already negotiated; also gives the audit trail the brief requires for pricing changes (alongside `AuditLog`).

### ADR-006 Double-entry ledger with cached wallet balances
**Decision:** `LedgerTransaction` (journal header, idempotency key) + `LedgerEntry` (lines). Wallet has three ledger accounts (AVAILABLE, PENDING, HELD). `Wallet.*Balance` columns are caches updated in the same DB transaction. `WalletTransaction` is the user-facing statement line pointing at its journal.
**Why:** reading balances by summing entries on every request is slow at scale; caches plus nightly recomputation give speed with verifiability.
**Consequence:** the only code allowed to write ledger tables is `LedgerService.post()`; enforced by lint rule (no `prisma.ledgerEntry.create` outside `modules/ledger`).

### ADR-007 Cash trips book only the commission debt
**Decision:** for cash rides the platform does not record the fare as platform money (it never touches it). It debits the driver's wallet for the commission. Drivers have a configurable `negativeLimit`; exceeding it blocks going online until they top up or electronic earnings cover it.
**Why:** mirrors reality; keeps cash and electronic flows strictly separate as the brief requires.

### ADR-008 State changes over REST, notifications over WebSocket
**Decision:** clients never change ride state or money through socket events. Sockets are for server push plus high-frequency location/heartbeat input.
**Why:** REST gives idempotency keys, status codes, rate limits, audit logs and retry semantics. Mixing transports for writes is the most common source of double-booking bugs in ride apps.

### ADR-009 PostGIS + Redis GEO
**Decision:** Redis GEO for live "who is near" queries (sub-ms, constantly changing); PostGIS for service-area polygons (point-in-polygon geofencing), history, analytics.
**Consequence:** Neon project must have the `postgis` extension enabled; Prisma models these as `Unsupported(...)` columns, so spatial queries use `$queryRaw` in one repository class per module.

### ADR-010 Prisma 7
**Decision:** Prisma `~7.10` with `prisma.config.ts` and the `@prisma/adapter-pg` driver adapter. Schema validated against the 7.10 engine.
**Consequence:** connection URLs are not in `schema.prisma`; generated client output is `packages/database/src/generated/client`.

### ADR-011 Turn-by-turn via deep link in v1
**Decision:** in-app route preview and ETAs with Google Maps; actual turn-by-turn handed to Google Maps/Waze app.
**Why:** embedded navigation SDKs add significant licensing cost and build complexity; drivers in Abuja already use Google Maps. Revisit after launch metrics.

### ADR-012 Trip PIN
**Decision:** 4-digit PIN generated at acceptance, stored hashed on `Ride`, shown in the passenger app, entered by the driver to start. 5 attempts, then admin override.
**Why:** prevents wrong-passenger pickups and drivers starting trips without the passenger.

### ADR-013 Data integrity in the database, not only in code
**Decision:** `001_integrity.sql` adds CHECK constraints, partial unique indexes, a deferred ledger-balance trigger, append-only triggers and the agreed-fare lock trigger.
**Why:** the brief's critical guarantees (no double booking, locked fare, balanced immutable ledger) must hold even if a future code change is wrong.
