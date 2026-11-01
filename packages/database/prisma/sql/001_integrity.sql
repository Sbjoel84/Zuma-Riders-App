-- =============================================================================
-- Integrity rules Prisma's schema language cannot express.
-- Phase 2: append this to the initial migration created by `prisma migrate dev --create-only`.
-- Table/column names follow Prisma defaults (PascalCase tables, camelCase columns).
-- =============================================================================

-- ---------- CHECK constraints ----------
ALTER TABLE "LedgerEntry"          ADD CONSTRAINT ledger_entry_amount_positive CHECK (amount > 0);
ALTER TABLE "RideRating"           ADD CONSTRAINT ride_rating_stars_range      CHECK (stars BETWEEN 1 AND 5);
ALTER TABLE "RideRequest"          ADD CONSTRAINT ride_request_fares_positive  CHECK ("proposedFare" > 0 AND "suggestedFare" > 0);
ALTER TABLE "RideOffer"            ADD CONSTRAINT ride_offer_amount_positive   CHECK (amount > 0);
ALTER TABLE "Ride"                 ADD CONSTRAINT ride_fare_positive           CHECK ("agreedFare" > 0 AND "discountAmount" >= 0 AND "discountAmount" <= "agreedFare");
ALTER TABLE "Payment"              ADD CONSTRAINT payment_amounts_valid        CHECK (amount > 0 AND "refundedAmount" >= 0 AND "refundedAmount" <= amount);
ALTER TABLE "Refund"               ADD CONSTRAINT refund_amount_positive       CHECK (amount > 0);
ALTER TABLE "Withdrawal"           ADD CONSTRAINT withdrawal_amount_positive   CHECK (amount > 0);
ALTER TABLE "Commission"           ADD CONSTRAINT commission_valid             CHECK (amount >= 0 AND amount <= "grossFare" AND "commissionBps" BETWEEN 0 AND 10000);
ALTER TABLE "PricingConfiguration" ADD CONSTRAINT pricing_bounds_valid         CHECK ("minFare" > 0 AND "maxFare" > "minFare" AND "commissionBps" BETWEEN 0 AND 10000);
-- availableBalance may go below -negativeLimit when cash commission is booked (a trip must never fail to
-- complete because of it); the limit is enforced in code by blocking go-online and withdrawals instead.
ALTER TABLE "Wallet"               ADD CONSTRAINT wallet_buckets_non_negative  CHECK ("pendingBalance" >= 0 AND "heldBalance" >= 0);

-- Only one active (effectiveTo IS NULL) pricing row per area+category.
CREATE UNIQUE INDEX pricing_one_active ON "PricingConfiguration" ("serviceAreaId", "categoryId") WHERE "effectiveTo" IS NULL;

-- A driver can only hold one live ride at a time.
CREATE UNIQUE INDEX ride_one_active_per_driver ON "Ride" ("driverId")
  WHERE status IN ('DRIVER_SELECTED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','TRIP_STARTED');

-- A passenger can only have one open request/ride at a time.
CREATE UNIQUE INDEX ride_request_one_open_per_passenger ON "RideRequest" ("passengerId")
  WHERE status IN ('REQUESTED','SEARCHING','OFFERS_RECEIVED');

-- ---------- Spatial indexes ----------
CREATE INDEX service_area_boundary_gix ON "ServiceArea"   USING GIST (boundary);
CREATE INDEX ride_request_pickup_gix   ON "RideRequest"   USING GIST ("pickupGeog");
CREATE INDEX driver_location_geog_gix  ON "DriverLocation" USING GIST (geog);

-- ---------- Double-entry: every ledger transaction must balance ----------
CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger AS $$
DECLARE d BIGINT; c BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DEBIT'),0),
         COALESCE(SUM(amount) FILTER (WHERE direction='CREDIT'),0)
    INTO d, c FROM "LedgerEntry" WHERE "transactionId" = NEW."transactionId";
  IF d <> c OR d = 0 THEN
    RAISE EXCEPTION 'Ledger transaction % unbalanced (debit %, credit %)', NEW."transactionId", d, c;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_balanced
  AFTER INSERT ON "LedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

-- ---------- Immutability ----------
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_immutable  BEFORE UPDATE OR DELETE ON "LedgerEntry"       FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_txn_immutable    BEFORE UPDATE OR DELETE ON "LedgerTransaction" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fare_negotiation_immut  BEFORE UPDATE OR DELETE ON "FareNegotiation"   FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ride_status_hist_immut  BEFORE UPDATE OR DELETE ON "RideStatusHistory" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_immutable     BEFORE UPDATE OR DELETE ON "AuditLog"          FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER admin_action_immutable  BEFORE UPDATE OR DELETE ON "AdminActionLog"    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Agreed fare is locked at acceptance.
CREATE OR REPLACE FUNCTION ride_lock_fare() RETURNS trigger AS $$
BEGIN
  IF NEW."agreedFare" <> OLD."agreedFare" OR NEW."acceptedOfferId" <> OLD."acceptedOfferId"
     OR NEW."driverId" <> OLD."driverId" OR NEW."passengerId" <> OLD."passengerId" THEN
    RAISE EXCEPTION 'Ride % fare/parties are locked after acceptance', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER ride_fare_locked BEFORE UPDATE ON "Ride" FOR EACH ROW EXECUTE FUNCTION ride_lock_fare();

-- ---------- Keep geography columns in sync with lat/lng ----------
CREATE OR REPLACE FUNCTION sync_pickup_geog() RETURNS trigger AS $$
BEGIN
  NEW."pickupGeog" := ST_SetSRID(ST_MakePoint(NEW."pickupLng", NEW."pickupLat"), 4326)::geography;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ride_request_geog BEFORE INSERT OR UPDATE OF "pickupLat","pickupLng" ON "RideRequest"
  FOR EACH ROW EXECUTE FUNCTION sync_pickup_geog();

CREATE OR REPLACE FUNCTION sync_point_geog() RETURNS trigger AS $$
BEGIN
  NEW.geog := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::geography;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER driver_location_geog BEFORE INSERT ON "DriverLocation"
  FOR EACH ROW EXECUTE FUNCTION sync_point_geog();

-- ---------- Least-privilege runtime role (run once per environment) ----------
-- The API connects as app_runtime; migrations run as the owner role.
-- REVOKE UPDATE, DELETE ON "LedgerEntry","LedgerTransaction","AuditLog","AdminActionLog",
--   "FareNegotiation","RideStatusHistory" FROM app_runtime;
