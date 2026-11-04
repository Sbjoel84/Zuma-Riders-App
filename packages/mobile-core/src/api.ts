import type { ApiError, AuthTokens, ErrorCode } from "@zuma/contracts";
import * as Crypto from "expo-crypto";
import { tokenStore } from "./storage";

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode | "NETWORK",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

type Listener = () => void;
const signedOutListeners = new Set<Listener>();
/** Called when refresh fails and the user must sign in again. */
export function onSignedOut(l: Listener) {
  signedOutListeners.add(l);
  return () => signedOutListeners.delete(l);
}

let refreshing: Promise<string | null> | null = null;

/** Single-flight refresh: many 401s at once trigger one refresh call. */
export async function refreshAccessToken(): Promise<string | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refreshToken = await tokenStore.getRefresh();
    if (!refreshToken) return null;
    try {
      const res = await fetch(`${API_URL}/v1/auth/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken }) });
      if (!res.ok) {
        await tokenStore.clear();
        signedOutListeners.forEach((l) => l());
        return null;
      }
      const t = (await res.json()) as AuthTokens;
      await tokenStore.save(t.accessToken, t.refreshToken);
      return t.accessToken;
    } catch {
      return null; // offline: keep tokens, try again later
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  body?: unknown;
  /** Adds an Idempotency-Key. Pass a string to reuse a key across retries of the same user action. */
  idempotencyKey?: string | boolean;
  auth?: boolean;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const doFetch = async (token: string | null) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", "X-App-Version": "0.1.0" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.idempotencyKey) headers["Idempotency-Key"] = typeof opts.idempotencyKey === "string" ? opts.idempotencyKey : Crypto.randomUUID();
    return fetch(`${API_URL}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  };

  let res: Response;
  try {
    const token = opts.auth === false ? null : await tokenStore.getAccess();
    res = await doFetch(token);
    if (res.status === 401 && opts.auth !== false) {
      const fresh = await refreshAccessToken();
      if (!fresh) throw new ApiRequestError(401, "UNAUTHENTICATED", "Please sign in again");
      res = await doFetch(fresh);
    }
  } catch (e) {
    if (e instanceof ApiRequestError) throw e;
    throw new ApiRequestError(0, "NETWORK", "No internet connection. Check your network and try again.");
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = (json as ApiError | undefined)?.error;
    throw new ApiRequestError(res.status, err?.code ?? "INTERNAL", err?.message ?? "Something went wrong", err?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown, idempotencyKey?: string | boolean) => request<T>("POST", path, { body: body ?? {}, idempotencyKey }),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
  publicPost: <T>(path: string, body?: unknown) => request<T>("POST", path, { body, auth: false }),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  return "Something went wrong. Try again.";
}
