import { Controller, Get, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { MapsService } from "../../infra/maps.service";
import { PrismaService } from "../../infra/prisma.service";
import { AvailabilityService } from "./availability.service";

const coord = z.coerce.number();

/** Server-side proxy for place search so billing keys never ship in the apps. */
@Controller("v1/maps")
export class MapsController {
  constructor(
    private readonly maps: MapsService,
    private readonly availability: AvailabilityService,
    private readonly prisma: PrismaService,
  ) {}

  @Get("autocomplete")
  autocomplete(@Query("input") input = "", @Query("sessionToken") sessionToken?: string, @Query("lat") lat?: string, @Query("lng") lng?: string) {
    const bias = lat && lng ? { lat: coord.parse(lat), lng: coord.parse(lng) } : undefined;
    return this.maps.autocomplete(input.slice(0, 100), sessionToken, bias);
  }

  @Get("place/:placeId")
  place(@Param("placeId") placeId: string, @Query("sessionToken") sessionToken?: string) {
    return this.maps.placeDetails(placeId, sessionToken);
  }

  @Get("reverse-geocode")
  reverse(@Query("lat") lat: string, @Query("lng") lng: string) {
    return this.maps.reverseGeocode({ lat: coord.parse(lat), lng: coord.parse(lng) });
  }

  /** Coarse, jittered positions of nearby free drivers for the passenger home map. No IDs. */
  @Get("nearby-drivers")
  async nearby(@Query("lat") lat: string, @Query("lng") lng: string) {
    const p = { lat: coord.parse(lat), lng: coord.parse(lng) };
    const area = await this.availability.serviceAreaAt(p.lat, p.lng);
    if (!area) return { inServiceArea: false, drivers: [] };
    const online = await this.prisma.db.driverAvailability.findMany({ where: { serviceAreaId: area.id, status: "ONLINE", lastLat: { not: null } }, take: 200 });
    const drivers = online
      .map((d) => ({ lat: d.lastLat! + (Math.random() - 0.5) * 0.002, lng: d.lastLng! + (Math.random() - 0.5) * 0.002 }))
      .filter((d) => Math.abs(d.lat - p.lat) < 0.05 && Math.abs(d.lng - p.lng) < 0.05)
      .slice(0, 30);
    return { inServiceArea: true, drivers };
  }
}
