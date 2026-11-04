import { Injectable, Logger } from "@nestjs/common";
import type { LatLng } from "@zuma/contracts";
import { env } from "../config/env";
import { DomainError } from "../common/errors";

export interface PlaceSuggestion {
  placeId: string;
  primary: string;
  secondary: string;
}

export interface PlaceDetails {
  placeId: string;
  address: string;
  lat: number;
  lng: number;
}

/** Development-only place list (MAPS_PROVIDER=estimate). Real searches go through Google Places. */
const DEV_PLACES: Array<PlaceDetails & { name: string; area: string }> = [
  { placeId: "dev:wuse2", name: "Wuse 2", area: "Aminu Kano Crescent, Abuja", address: "Wuse 2, Aminu Kano Crescent, Abuja", lat: 9.0765, lng: 7.479 },
  { placeId: "dev:banex", name: "Banex Plaza", area: "Wuse 2, Abuja", address: "Banex Plaza, Wuse 2, Abuja", lat: 9.0772, lng: 7.4801 },
  { placeId: "dev:airport", name: "Nnamdi Azikiwe International Airport", area: "Airport Road, Abuja", address: "Nnamdi Azikiwe International Airport, Abuja", lat: 9.0068, lng: 7.2632 },
  { placeId: "dev:jabi", name: "Jabi Lake Mall", area: "Jabi, Abuja", address: "Jabi Lake Mall, Jabi, Abuja", lat: 9.0703, lng: 7.4247 },
  { placeId: "dev:maitama", name: "Maitama District", area: "Abuja", address: "Maitama District, Abuja", lat: 9.0882, lng: 7.4934 },
  { placeId: "dev:garki", name: "Garki Area 11", area: "Garki, Abuja", address: "Garki Area 11, Abuja", lat: 9.0398, lng: 7.4876 },
  { placeId: "dev:asokoro", name: "Asokoro", area: "Abuja", address: "Asokoro District, Abuja", lat: 9.0435, lng: 7.5238 },
  { placeId: "dev:gwarinpa", name: "Gwarinpa", area: "1st Avenue, Abuja", address: "1st Avenue, Gwarinpa, Abuja", lat: 9.1099, lng: 7.4042 },
  { placeId: "dev:kubwa", name: "Kubwa", area: "Kubwa Expressway, Abuja", address: "Kubwa, Abuja", lat: 9.1559, lng: 7.3221 },
  { placeId: "dev:lugbe", name: "Lugbe", area: "Airport Road, Abuja", address: "Lugbe, Abuja", lat: 8.9823, lng: 7.3776 },
  { placeId: "dev:central", name: "Central Business District", area: "Abuja", address: "Central Business District, Abuja", lat: 9.0579, lng: 7.4951 },
  { placeId: "dev:wusemarket", name: "Wuse Market", area: "Wuse Zone 5, Abuja", address: "Wuse Market, Zone 5, Abuja", lat: 9.0628, lng: 7.4666 },
  { placeId: "dev:lifecamp", name: "Life Camp", area: "Abuja", address: "Life Camp, Abuja", lat: 9.0809, lng: 7.4029 },
  { placeId: "dev:utako", name: "Utako Market", area: "Utako, Abuja", address: "Utako Market, Abuja", lat: 9.0661, lng: 7.4431 },
  { placeId: "dev:millennium", name: "Millennium Park", area: "Maitama, Abuja", address: "Millennium Park, Maitama, Abuja", lat: 9.0711, lng: 7.5024 },
];

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

  async autocomplete(input: string, sessionToken: string | undefined, bias?: LatLng): Promise<PlaceSuggestion[]> {
    const q = input.trim();
    if (q.length < 2) return [];
    if (env().MAPS_PROVIDER !== "google") {
      const lc = q.toLowerCase();
      return DEV_PLACES.filter((p) => p.name.toLowerCase().includes(lc) || p.area.toLowerCase().includes(lc)).slice(0, 8).map((p) => ({ placeId: p.placeId, primary: p.name, secondary: p.area }));
    }
    const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": env().GOOGLE_MAPS_API_KEY! },
      body: JSON.stringify({
        input: q, sessionToken, includedRegionCodes: ["ng"], languageCode: "en",
        ...(bias ? { locationBias: { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 30000 } } } : {}),
      }),
    });
    if (!res.ok) throw new DomainError("INTERNAL", "Place search is temporarily unavailable");
    const json = (await res.json()) as { suggestions?: Array<{ placePrediction?: { placeId: string; structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } } } }> };
    return (json.suggestions ?? []).flatMap((s) => (s.placePrediction ? [{ placeId: s.placePrediction.placeId, primary: s.placePrediction.structuredFormat?.mainText?.text ?? "", secondary: s.placePrediction.structuredFormat?.secondaryText?.text ?? "" }] : []));
  }

  async placeDetails(placeId: string, sessionToken?: string): Promise<PlaceDetails> {
    if (env().MAPS_PROVIDER !== "google") {
      const p = DEV_PLACES.find((x) => x.placeId === placeId);
      if (!p) throw new DomainError("NOT_FOUND", "Place not found");
      return { placeId: p.placeId, address: p.address, lat: p.lat, lng: p.lng };
    }
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : ""}`;
    const res = await fetch(url, { headers: { "X-Goog-Api-Key": env().GOOGLE_MAPS_API_KEY!, "X-Goog-FieldMask": "id,formattedAddress,displayName,location" } });
    if (!res.ok) throw new DomainError("NOT_FOUND", "Place not found");
    const j = (await res.json()) as { id: string; formattedAddress?: string; displayName?: { text?: string }; location?: { latitude: number; longitude: number } };
    if (!j.location) throw new DomainError("NOT_FOUND", "Place has no location");
    const name = j.displayName?.text;
    const address = name && j.formattedAddress && !j.formattedAddress.startsWith(name) ? `${name}, ${j.formattedAddress}` : (j.formattedAddress ?? name ?? "Selected place");
    return { placeId: j.id, address, lat: j.location.latitude, lng: j.location.longitude };
  }

  async reverseGeocode(p: LatLng): Promise<{ address: string }> {
    if (env().MAPS_PROVIDER !== "google") {
      const nearest = [...DEV_PLACES].sort((a, b) => haversineM(p, a) - haversineM(p, b))[0]!;
      return { address: haversineM(p, nearest) < 1500 ? `Near ${nearest.name}, Abuja` : `Pinned location (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})` };
    }
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${p.lat},${p.lng}&key=${env().GOOGLE_MAPS_API_KEY}&region=ng`);
    const j = (await res.json()) as { results?: Array<{ formatted_address: string }> };
    return { address: j.results?.[0]?.formatted_address ?? `Pinned location (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})` };
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
