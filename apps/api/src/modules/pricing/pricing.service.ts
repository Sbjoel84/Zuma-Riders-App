import { Injectable } from "@nestjs/common";
import type { CategoryEstimate, EstimateBody, EstimateResponse } from "@zuma/contracts";
import type { PricingConfiguration } from "@zuma/database";
import { fail } from "../../common/errors";
import { MapsService, type Route } from "../../infra/maps.service";
import { PrismaService } from "../../infra/prisma.service";
import { AvailabilityService } from "../geo/availability.service";

const ROUND = 5000n; // fares are rounded to the nearest ₦50

const roundTo = (v: bigint, step: bigint) => ((v + step / 2n) / step) * step;
const floorTo = (v: bigint, step: bigint) => (v / step) * step;

export interface FareBounds {
  suggested: bigint;
  min: bigint;
  max: bigint;
}

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maps: MapsService,
    private readonly availability: AvailabilityService,
  ) {}

  /** Pure fare maths, unit-tested. */
  static bounds(cfg: Pick<PricingConfiguration, "baseFare" | "perKm" | "perMinute" | "minFare" | "maxFare" | "minFarePerKm">, distanceM: number, durationS: number): FareBounds {
    const km = BigInt(Math.round(distanceM)) ;
    const sec = BigInt(Math.round(durationS));
    const metered = cfg.baseFare + (cfg.perKm * km) / 1000n + (cfg.perMinute * sec) / 60n;
    const perKmFloor = floorTo((cfg.minFarePerKm * km) / 1000n, ROUND);
    const min = cfg.minFare > perKmFloor ? cfg.minFare : perKmFloor;
    let suggested = roundTo(metered, ROUND);
    if (suggested < min) suggested = min;
    if (suggested > cfg.maxFare) suggested = cfg.maxFare;
    return { suggested, min, max: cfg.maxFare };
  }

  async activeConfig(serviceAreaId: string, categoryId: string) {
    const cfg = await this.prisma.db.pricingConfiguration.findFirst({ where: { serviceAreaId, categoryId, effectiveTo: null }, orderBy: { version: "desc" } });
    return cfg ?? fail("CATEGORY_UNAVAILABLE", "This vehicle type has no pricing in this area yet");
  }

  async enabledCategories(cityId: string, restrictedKeys: string[]) {
    const rows = await this.prisma.db.cityVehicleCategory.findMany({
      where: { cityId, isEnabled: true, category: { isActive: true } },
      include: { category: true },
      orderBy: { category: { sortOrder: "asc" } },
    });
    return rows.map((r) => r.category).filter((c) => !restrictedKeys.includes(c.key));
  }

  async estimate(body: EstimateBody): Promise<EstimateResponse & { route: Route; cityId: string }> {
    const area = await this.availability.serviceAreaAt(body.pickup.lat, body.pickup.lng);
    if (!area) fail("OUTSIDE_SERVICE_AREA", "Pickup is outside our service area");
    const dropArea = await this.availability.serviceAreaAt(body.dropoff.lat, body.dropoff.lng);
    if (!dropArea || dropArea.cityId !== area!.cityId) fail("OUTSIDE_SERVICE_AREA", "Destination is outside our service area");

    const route = await this.maps.route(body.pickup, body.dropoff);
    if (route.distanceM < 200) fail("VALIDATION_FAILED", "Pickup and destination are too close together");

    let cats = await this.enabledCategories(area!.cityId, area!.restrictedCategoryKeys);
    if (body.categoryKey) cats = cats.filter((c) => c.key === body.categoryKey);
    const categories: CategoryEstimate[] = [];
    for (const c of cats) {
      const cfg = await this.prisma.db.pricingConfiguration.findFirst({ where: { serviceAreaId: area!.id, categoryId: c.id, effectiveTo: null } });
      if (!cfg) continue;
      const b = PricingService.bounds(cfg, route.distanceM, route.durationS);
      categories.push({ categoryKey: c.key, name: c.name, seats: c.seats, suggestedFare: b.suggested.toString(), minFare: b.min.toString(), maxFare: b.max.toString() });
    }
    if (body.categoryKey && categories.length === 0) fail("CATEGORY_UNAVAILABLE", "That vehicle type is not available here");
    return { distanceM: route.distanceM, durationS: route.durationS, polyline: route.polyline, serviceAreaId: area!.id, cityId: area!.cityId, categories, route };
  }

  /** Validates a passenger proposal against the snapshot config. */
  static assertProposal(fare: bigint, b: FareBounds) {
    if (fare < b.min) fail("FARE_BELOW_MINIMUM", `The minimum fare for this trip is ₦${(b.min / 100n).toLocaleString()}`, { minFare: b.min.toString() });
    if (fare > b.max) fail("FARE_ABOVE_MAXIMUM", `The maximum fare for this trip is ₦${(b.max / 100n).toLocaleString()}`, { maxFare: b.max.toString() });
  }

  /** Highest counter-offer a driver may send for a given proposal. */
  static maxCounter(proposed: bigint, cfg: Pick<PricingConfiguration, "maxFare" | "maxCounterOfferPctAbove">): bigint {
    const cap = (proposed * BigInt(100 + cfg.maxCounterOfferPctAbove)) / 100n;
    return cap < cfg.maxFare ? floorTo(cap, ROUND) : cfg.maxFare;
  }
}
