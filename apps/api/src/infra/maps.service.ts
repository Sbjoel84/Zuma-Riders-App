import { Injectable, Logger } from "@nestjs/common";
import type { LatLng } from "@zuma/contracts";
import { env } from "../config/env";
import { DomainError } from "../common/errors";

export interface Route {
  distanceM: number;
  durationS: number;
  polyline: string | null;
  source: "google" | "estimate";
}

/** Great-circle distance in metres. Used only as a pre-filter or in the dev estimator — never for fares in production. */
export function haversineM(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

@Injectable()
export class MapsService {
  private readonly log = new Logger("Maps");

  async route(origin: LatLng, destination: LatLng): Promise<Route> {
    return env().MAPS_PROVIDER === "google" ? this.googleRoute(origin, destination) : this.estimate(origin, destination);
  }

  /**
   * Development-only estimator: straight line × 1.35 road factor at 28 km/h average.
   * Env validation refuses this provider in production (the brief forbids straight-line fares).
   */
  private estimate(o: LatLng, d: LatLng): Route {
    const distanceM = Math.round(haversineM(o, d) * 1.35);
    const durationS = Math.max(60, Math.round(distanceM / (28000 / 3600)));
    return { distanceM, durationS, polyline: null, source: "estimate" };
  }

  /** Google Routes API (computeRoutes), traffic-aware. */
  private async googleRoute(o: LatLng, d: LatLng): Promise<Route> {
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env().GOOGLE_MAPS_API_KEY!,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: o.lat, longitude: o.lng } } },
        destination: { location: { latLng: { latitude: d.lat, longitude: d.lng } } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        regionCode: "NG",
      }),
    });
    if (!res.ok) {
      this.log.error(`Routes API failed: ${res.status} ${await res.text().catch(() => "")}`);
      throw new DomainError("INTERNAL", "Route calculation is temporarily unavailable");
    }
    const json = (await res.json()) as { routes?: Array<{ distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string } }> };
    const r = json.routes?.[0];
    if (!r?.distanceMeters || !r.duration) throw new DomainError("VALIDATION_FAILED", "No driving route found between these points");
    return { distanceM: r.distanceMeters, durationS: parseInt(r.duration, 10), polyline: r.polyline?.encodedPolyline ?? null, source: "google" };
  }
}
