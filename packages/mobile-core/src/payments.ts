import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { api } from "./api";

export interface PaymentView {
  reference: string;
  purpose: string;
  status: "INITIATED" | "PENDING" | "SUCCEEDED" | "FAILED" | "ABANDONED" | string;
  amount: string;
  failureReason: string | null;
  card: { brand: string | null; last4: string | null } | null;
}

export interface SavedCard {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  bank: string | null;
  isDefault: boolean;
}

/**
 * Card checkout through Paystack in an in-app browser. Paystack redirects to `<scheme>://payments/return`,
 * which closes the browser; the API then verifies the payment server-side (never trusting the redirect).
 * The webhook may already have credited the wallet; verify is idempotent either way.
 */
export async function payByCard(amountKobo: string, scheme: "zuma" | "zumadriver"): Promise<PaymentView> {
  const returnUrl = `${scheme}://payments/return`;
  const start = await api.post<{ reference: string; authorizationUrl: string }>("/v1/payments/topups", { amount: amountKobo, returnUrl }, Crypto.randomUUID());
  await WebBrowser.openAuthSessionAsync(start.authorizationUrl, returnUrl);
  // Whether the customer finished, cancelled or closed the browser, ask the API for the truth.
  let p = await api.post<PaymentView>(`/v1/payments/${start.reference}/verify`);
  for (let i = 0; i < 3 && (p.status === "PENDING" || p.status === "INITIATED"); i++) {
    await new Promise((r) => setTimeout(r, 1500));
    p = await api.post<PaymentView>(`/v1/payments/${start.reference}/verify`);
  }
  return p;
}
