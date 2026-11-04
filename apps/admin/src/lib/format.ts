/** Kobo strings → naira text. Never does arithmetic in floats. */
export function naira(kobo: string | bigint | null | undefined, opts: { compact?: boolean } = {}): string {
  if (kobo === null || kobo === undefined || kobo === "") return "—";
  const n = BigInt(kobo);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  if (opts.compact && abs >= 100_000_000n) {
    const m = Number(abs / 1_000_000n) / 100; // naira millions with 2 dp
    return `${neg ? "−" : ""}₦${m.toFixed(m >= 100 ? 0 : 2)}m`;
  }
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = abs % 100n;
  return `${neg ? "−" : ""}₦${whole}${frac ? "." + frac.toString().padStart(2, "0") : ""}`;
}

/** Naira input ("1,500.50") → kobo string, or null if invalid. */
export function toKobo(input: string): string | null {
  const clean = input.replace(/[₦,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [w, f = ""] = clean.split(".");
  return (BigInt(w!) * 100n + BigInt((f + "00").slice(0, 2))).toString();
}

export const nairaInput = (kobo: string) => {
  const n = BigInt(kobo);
  return (n % 100n === 0n ? (n / 100n).toString() : (Number(n) / 100).toFixed(2));
};

const LAGOS = "Africa/Lagos";

export function dateTime(iso: string | Date | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { timeZone: LAGOS, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function time(iso: string | Date | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-GB", { timeZone: LAGOS, hour: "2-digit", minute: "2-digit" });
}

export function ago(iso: string | Date | null | undefined) {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const km = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);
export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
export const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function todayLabel() {
  return new Date().toLocaleDateString("en-GB", { timeZone: LAGOS, weekday: "long", day: "numeric", month: "long" });
}
