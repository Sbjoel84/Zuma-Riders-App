import { createHmac, randomInt } from "crypto";
import { env } from "../../config/env";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Short human reference, e.g. R-7K2QX9. Uniqueness is guaranteed by the DB unique index; callers retry. */
export function shortCode(prefix: string, len = 6): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${s}`;
}

/**
 * Trip PIN is derived, not stored: HMAC(secret, rideId) → 4 digits. The passenger app can always
 * re-display it after a restart, and the DB only keeps a hash for audit.
 */
export function tripPin(rideId: string): string {
  const h = createHmac("sha256", env().TRIP_PIN_SECRET).update(rideId).digest();
  return (h.readUInt32BE(0) % 10000).toString().padStart(4, "0");
}

export function tripPinHash(rideId: string): string {
  return createHmac("sha256", env().TRIP_PIN_SECRET).update(`hash:${rideId}:${tripPin(rideId)}`).digest("hex");
}

export function maskPhone(e164: string): string {
  return e164.length > 7 ? e164.slice(0, 7) + "***" + e164.slice(-3) : "***";
}

export function areaName(address: string): string {
  return address.split(",")[0]!.trim().slice(0, 60);
}
