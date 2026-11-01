import { Money, normalizeNigerianPhone } from "@zuma/contracts";
import { PricingService } from "../src/modules/pricing/pricing.service";
import { rankScore } from "../src/modules/rides/matching.service";
import { passengerCancellationFee, transition, TRIP_EDGES } from "../src/modules/rides/state-machine";
import type { RideStatus } from "@zuma/contracts";

const N = (n: number) => BigInt(n * 100);

describe("trip state machine", () => {
  const all: RideStatus[] = ["REQUESTED", "SEARCHING", "OFFERS_RECEIVED", "DRIVER_SELECTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "TRIP_STARTED", "TRIP_COMPLETED", "CANCELLED", "EXPIRED", "DISPUTED"];

  it("allows only the defined edges, for every state × event × actor", () => {
    for (const from of all) {
      for (const [event, edge] of Object.entries(TRIP_EDGES)) {
        for (const actor of ["PASSENGER", "DRIVER", "ADMIN", "SYSTEM"] as const) {
          const r = transition(from, event as keyof typeof TRIP_EDGES, actor);
          const expected = edge.actors.includes(actor) && edge.from.includes(from);
          expect(r.ok).toBe(expected);
          if (r.ok) expect(r.to).toBe(edge.to);
        }
      }
    }
  });

  it("does not let a passenger start or complete a trip", () => {
    expect(transition("DRIVER_ARRIVED", "START", "PASSENGER")).toEqual({ ok: false, reason: "ACTOR_NOT_ALLOWED" });
    expect(transition("TRIP_STARTED", "COMPLETE", "PASSENGER")).toEqual({ ok: false, reason: "ACTOR_NOT_ALLOWED" });
  });

  it("does not allow cancelling a started or completed trip", () => {
    expect(transition("TRIP_STARTED", "CANCEL", "PASSENGER").ok).toBe(false);
    expect(transition("TRIP_COMPLETED", "CANCEL", "DRIVER").ok).toBe(false);
  });

  it("charges the passenger cancellation fee only after the grace window and once the driver is moving", () => {
    const assignedAt = new Date("2026-11-01T10:00:00Z");
    const base = { assignedAt, graceSeconds: 120, fee: N(500) };
    expect(passengerCancellationFee({ ...base, status: "DRIVER_EN_ROUTE", now: new Date("2026-11-01T10:01:00Z") })).toBe(0n);
    expect(passengerCancellationFee({ ...base, status: "DRIVER_EN_ROUTE", now: new Date("2026-11-01T10:03:00Z") })).toBe(N(500));
    expect(passengerCancellationFee({ ...base, status: "DRIVER_SELECTED", now: new Date("2026-11-01T10:30:00Z") })).toBe(0n);
  });
});

describe("fare bounds", () => {
  const cfg = { baseFare: N(500), perKm: N(120), perMinute: N(15), minFare: N(1200), maxFare: N(25000), minFarePerKm: N(60), maxCounterOfferPctAbove: 100 };

  it("suggests base + distance + time, rounded to ₦50", () => {
    // 10 km, 20 min → 500 + 1200 + 300 = ₦2,000
    expect(PricingService.bounds(cfg, 10_000, 1200).suggested).toBe(N(2000));
    // 10.2 km, 20.3 min → 500 + 1224 + 304.5 = 2028.5 → ₦2,050
    expect(PricingService.bounds(cfg, 10_200, 1218).suggested).toBe(N(2050));
  });

  it("never suggests below the minimum fare or above the maximum", () => {
    expect(PricingService.bounds(cfg, 1000, 120).suggested).toBe(N(1200));
    expect(PricingService.bounds(cfg, 400_000, 30_000).suggested).toBe(N(25000));
  });

  it("raises the floor on long trips to the per-km minimum", () => {
    // 38 km × ₦60 = ₦2,280 > ₦1,200 minimum
    expect(PricingService.bounds(cfg, 38_000, 2460).min).toBe(N(2250));
  });

  it("rejects proposals outside the bounds", () => {
    const b = PricingService.bounds(cfg, 10_000, 1200);
    expect(() => PricingService.assertProposal(N(1100), b)).toThrow(expect.objectContaining({ code: "FARE_BELOW_MINIMUM" }));
    expect(() => PricingService.assertProposal(N(26000), b)).toThrow(expect.objectContaining({ code: "FARE_ABOVE_MAXIMUM" }));
    expect(() => PricingService.assertProposal(N(1500), b)).not.toThrow();
  });

  it("caps driver counter-offers at +100% of the proposal and the max fare", () => {
    expect(PricingService.maxCounter(N(3000), cfg)).toBe(N(6000));
    expect(PricingService.maxCounter(N(20000), cfg)).toBe(N(25000));
  });
});

describe("money", () => {
  it("computes commission in basis points, rounding down so the remainder stays with the driver", () => {
    expect(Money.commission(N(6500), 1500)).toBe(N(975));
    expect(Money.commission(333n, 1500)).toBe(49n); // 49.95 kobo → 49
  });

  it("formats kobo as naira", () => {
    expect(Money.format(650000n)).toBe("₦6,500");
    expect(Money.format("123456")).toBe("₦1,234.56");
  });

  it("normalises Nigerian phone numbers", () => {
    expect(normalizeNigerianPhone("0803 123 4567")).toBe("+2348031234567");
    expect(normalizeNigerianPhone("8031234567")).toBe("+2348031234567");
    expect(normalizeNigerianPhone("2348031234567")).toBe("+2348031234567");
    expect(normalizeNigerianPhone("+447700900123")).toBe("+447700900123");
    expect(normalizeNigerianPhone("12345")).toBeNull();
  });
});

describe("driver ranking", () => {
  it("prefers closer drivers, then better rated", () => {
    const near = { driverId: "a", distanceM: 300, ratingAvg: 4.6, acceptanceRate: 0.9, cancellationRate: 0.05 };
    const far = { driverId: "b", distanceM: 2800, ratingAvg: 4.9, acceptanceRate: 0.9, cancellationRate: 0.05 };
    expect(rankScore(near, 3000)).toBeGreaterThan(rankScore(far, 3000));
    const sameDistBetter = { ...near, driverId: "c", ratingAvg: 4.95 };
    expect(rankScore(sameDistBetter, 3000)).toBeGreaterThan(rankScore(near, 3000));
  });
});
