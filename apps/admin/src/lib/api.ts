export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Access token lives in memory only. The refresh token is kept in sessionStorage so a reload
 * doesn't sign the operator out, but closing the tab does. (An httpOnly refresh cookie replaces
 * this when the API gains cookie sessions; see docs/STANDARDS.md.)
 */
const REFRESH_KEY = "zuma.admin.refresh";
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const signedOut = new Set<() => void>();

export const session = {
  set(access: string, refresh: string) {
    accessToken = access;
    try {
      sessionStorage.setItem(REFRESH_KEY, refresh);
    } catch {
      /* storage blocked: session lasts until reload */
    }
  },
  hasRefresh() {
    try {
      return !!sessionStorage.getItem(REFRESH_KEY);
    } catch {
      return false;
    }
  },
  clear() {
    accessToken = null;
    try {
      sessionStorage.removeItem(REFRESH_KEY);
    } catch {
      /* ignore */
    }
  },
  onSignedOut(fn: () => void): () => void {
    signedOut.add(fn);
    return () => {
      signedOut.delete(fn);
    };
  },
};

async function refresh(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    let token: string | null = null;
    try {
      token = sessionStorage.getItem(REFRESH_KEY);
    } catch {
      /* ignore */
    }
    if (!token) return false;
    try {
      const res = await fetch(`${API_URL}/v1/auth/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: token }) });
      if (!res.ok) {
        session.clear();
        signedOut.forEach((f) => f());
        return false;
      }
      const t = (await res.json()) as { accessToken: string; refreshToken: string };
      session.set(t.accessToken, t.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function request<T>(method: string, path: string, body?: unknown, opts: { idempotent?: boolean; auth?: boolean } = {}): Promise<T> {
  const send = () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.auth !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (opts.idempotent) headers["Idempotency-Key"] = crypto.randomUUID();
    return fetch(`${API_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  let res: Response;
  try {
    if (opts.auth !== false && !accessToken) await refresh();
    res = await send();
    if (res.status === 401 && opts.auth !== false && (await refresh())) res = await send();
  } catch {
    throw new ApiError(0, "NETWORK", "Can't reach the Riders App API. Check your connection.");
  }
  if (res.status === 401 && opts.auth !== false) {
    session.clear();
    signedOut.forEach((f) => f());
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? "INTERNAL", e?.message ?? "Something went wrong", e?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  publicPost: <T>(path: string, body?: unknown) => request<T>("POST", path, body, { auth: false }),
};

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong");
