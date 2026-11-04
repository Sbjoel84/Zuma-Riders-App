import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, session } from "./api";

export interface AdminMe {
  id: string;
  name: string;
  phone: string;
  roles: { key: string; name: string }[];
  permissions: string[];
}

interface AuthState {
  status: "loading" | "signedOut" | "signedIn";
  me: AdminMe | null;
  can: (permission: string) => boolean;
  requestCode: (phone: string) => Promise<string>;
  verifyCode: (otpId: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

function installId() {
  try {
    let id = localStorage.getItem("zuma.admin.install");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("zuma.admin.install", id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [me, setMe] = useState<AdminMe | null>(null);

  const loadMe = useCallback(async () => {
    const m = await api.get<AdminMe>("/v1/admin/me");
    setMe(m);
    setStatus("signedIn");
  }, []);

  useEffect(() => {
    if (!session.hasRefresh()) return setStatus("signedOut");
    loadMe().catch(() => setStatus("signedOut"));
  }, [loadMe]);

  useEffect(
    () =>
      session.onSignedOut(() => {
        setMe(null);
        setStatus("signedOut");
        qc.clear();
      }),
    [qc],
  );

  const value: AuthState = {
    status,
    me,
    can: (p) => !!me?.permissions.includes(p),
    requestCode: async (phone) => (await api.publicPost<{ otpId: string }>("/v1/auth/otp/request", { phone, appScope: "ADMIN" })).otpId,
    verifyCode: async (otpId, code) => {
      const t = await api.publicPost<{ accessToken: string; refreshToken: string }>("/v1/auth/otp/verify", { otpId, code, appScope: "ADMIN", device: { installId: installId(), platform: "WEB", model: navigator.userAgent.slice(0, 90) } });
      session.set(t.accessToken, t.refreshToken);
      await loadMe();
    },
    signOut: async () => {
      await api.post("/v1/auth/logout").catch(() => undefined);
      session.clear();
      qc.clear();
      setMe(null);
      setStatus("signedOut");
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}
