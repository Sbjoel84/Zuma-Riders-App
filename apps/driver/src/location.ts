import { api, getSocket } from "@zuma/mobile-core";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

/**
 * Driver location while online. A background task (Android foreground service / iOS background
 * location) keeps sending positions when the app is minimised. Each point goes over the socket when
 * connected, otherwise via the REST fallback, so the heartbeat never lapses while the driver is online.
 */
export const LOCATION_TASK = "zuma-driver-location";

let seq = Date.now() % 1_000_000_000;
let last: { lat: number; lng: number; at: number } | null = null;

export function lastKnown() {
  return last;
}

export async function sendPoint(loc: Location.LocationObject) {
  const point = {
    lat: loc.coords.latitude,
    lng: loc.coords.longitude,
    heading: loc.coords.heading !== null && loc.coords.heading >= 0 ? loc.coords.heading : undefined,
    speedKmh: loc.coords.speed !== null && loc.coords.speed >= 0 ? loc.coords.speed * 3.6 : undefined,
    accuracyM: loc.coords.accuracy ?? undefined,
    recordedAt: new Date(loc.timestamp).toISOString(),
    clientSeq: ++seq,
  };
  last = { lat: point.lat, lng: point.lng, at: Date.now() };
  const s = getSocket();
  if (s?.connected) {
    s.emit("driver.location", point);
  } else {
    await api.post("/v1/driver/location", point).catch(() => undefined);
  }
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const latest = data.locations[data.locations.length - 1]!;
  await sendPoint(latest);
});

export type PermissionResult = "granted" | "foreground-only" | "denied";

export async function requestPermissions(): Promise<PermissionResult> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return "denied";
  const bg = await Location.requestBackgroundPermissionsAsync().catch(() => ({ status: "denied" as const }));
  return bg.status === "granted" ? "granted" : "foreground-only";
}

export async function startTracking() {
  const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (already) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 4000,
    distanceInterval: 25,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "You're online on Riders App",
      notificationBody: "Sharing your location to receive ride requests.",
      notificationColor: "#f2a900",
    },
  });
}

export async function stopTracking() {
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
}

export async function currentPosition() {
  const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  await sendPoint(p).catch(() => undefined);
  return { lat: p.coords.latitude, lng: p.coords.longitude };
}
