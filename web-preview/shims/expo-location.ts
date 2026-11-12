// Web-preview location: a fixed spot in Abuja (set localStorage "zuma.previewLoc" = "lat,lng" to move).
import { __run } from "./expo-task-manager";
const here = () => {
  const s = globalThis.localStorage?.getItem("zuma.previewLoc");
  const [lat, lng] = s ? s.split(",").map(Number) : [9.0765, 7.479];
  return { coords: { latitude: lat!, longitude: lng!, accuracy: 10, heading: 0, speed: 0, altitude: 0, altitudeAccuracy: 0 }, timestamp: Date.now() };
};
export const Accuracy = { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 };
export const ActivityType = { AutomotiveNavigation: 2, Other: 1 };
export const PermissionStatus = { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" };
const granted = async () => ({ status: "granted", granted: true, canAskAgain: true, expires: "never" });
export const requestForegroundPermissionsAsync = granted;
export const requestBackgroundPermissionsAsync = granted;
export const getForegroundPermissionsAsync = granted;
export const getBackgroundPermissionsAsync = granted;
export const hasServicesEnabledAsync = async () => true;
export const getCurrentPositionAsync = async () => here();
export const getLastKnownPositionAsync = async () => here();
export const watchPositionAsync = async (_o: unknown, cb: (l: ReturnType<typeof here>) => void) => { cb(here()); const t = setInterval(() => cb(here()), 4000); return { remove: () => clearInterval(t) }; };
let timer: ReturnType<typeof setInterval> | null = null;
export const hasStartedLocationUpdatesAsync = async () => timer !== null;
export const startLocationUpdatesAsync = async (task: string) => { const tick = () => __run(task, { locations: [here()] }); tick(); timer = setInterval(tick, 4000); };
export const stopLocationUpdatesAsync = async () => { if (timer) clearInterval(timer); timer = null; };
export const reverseGeocodeAsync = async () => [];
export const geocodeAsync = async () => [];
