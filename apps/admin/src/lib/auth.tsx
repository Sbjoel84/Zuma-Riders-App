import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, session } from "./api";

export interface AdminMe {
  id: string;
  name: string;
  phone: string;
  roles: { key: string; name: string }[];
  permissions: string[];
}

interface AuthState {
  /** mfaSetup: signed in, but must enrol an authenticator app before using the console. */
  status: "loading" | "signedOut" | "signedIn" | "mfaSetup";
  me: AdminMe | null;
  can: (permission: string) => boolean;
  requestCode: (phone: string) => Promise<string>;
  /** Returns an MFA ticket when the account has an authenticator app; otherwise signs in. */
  verifyCode: (otpId: string, code: string) => Promise<{ mfaToken: string } | null>;
  verifyMfa: (mfaToken: string, code: string) => Promise<void>;
  reload: () => Promise<void>;
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
    try {
      const m = await api.get<AdminMe>("/v1/admin/me");
      setMe(m);
      setStatus("signedIn");
    } catch (e) {
      if (e instanceof ApiError && e.code === "MFA_SETUP_REQUIRED") {
        setMe(null);
        setStatus("mfaSetup");
        return;
      }
      throw e;
    }
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
      const t = await api.publicPost<{ accessToken?: string; refreshToken?: string; mfaRequired?: boolean; mfaToken?: string }>("/v1/auth/otp/verify", { otpId, code, appScope: "ADMIN", device: { installId: installId(), platform: "WEB", model: navigator.userAgent.slice(0, 90) } });
      if (t.mfaRequired && t.mfaToken) return { mfaToken: t.mfaToken };
      session.set(t.accessToken!, t.refreshToken!);
      await loadMe();
      return null;
    },
    verifyMfa: async (mfaToken, code) => {
      const t = await api.publicPost<{ accessToken: string; refreshToken: string }>("/v1/auth/mfa/verify", { mfaToken, code });
      session.set(t.accessToken, t.refreshToken);
      await loadMe();
    },
    reload: loadMe,
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
