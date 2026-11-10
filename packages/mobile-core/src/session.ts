import type { AppScope, AuthTokens, MeResponse } from "@zuma/contracts";
import { Platform } from "react-native";
import { create } from "zustand";
import { api, onSignedOut } from "./api";
import { unregisterPush } from "./push";
import { installId, tokenStore } from "./storage";

type Status = "loading" | "signedOut" | "signedIn";

interface SessionState {
  status: Status;
  scope: AppScope;
  me: MeResponse | null;
  bootstrap: (scope: AppScope) => Promise<void>;
  requestOtp: (phone: string) => Promise<{ otpId: string; resendAfterS: number }>;
  verifyOtp: (otpId: string, code: string) => Promise<void>;
  refreshMe: () => Promise<MeResponse | null>;
  signOut: () => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  status: "loading",
  scope: "PASSENGER",
  me: null,

  bootstrap: async (scope) => {
    set({ scope });
    const token = await tokenStore.getRefresh();
    if (!token) return set({ status: "signedOut" });
    try {
      const me = await api.get<MeResponse>("/v1/me");
      set({ me, status: "signedIn" });
    } catch (e) {
      // Offline with valid tokens: let the user in; screens show connectivity errors.
      const code = (e as { code?: string }).code;
      set({ status: code === "NETWORK" ? "signedIn" : "signedOut" });
    }
  },

  requestOtp: async (phone) => api.publicPost<{ otpId: string; resendAfterS: number }>("/v1/auth/otp/request", { phone, appScope: get().scope }),

  verifyOtp: async (otpId, code) => {
    const device = { installId: await installId(), platform: Platform.OS === "ios" ? "IOS" : Platform.OS === "android" ? "ANDROID" : "WEB", appVersion: "0.1.0" };
    const t = await api.publicPost<AuthTokens & { isNewUser: boolean }>("/v1/auth/otp/verify", { otpId, code, appScope: get().scope, device });
    await tokenStore.save(t.accessToken, t.refreshToken);
    const me = await api.get<MeResponse>("/v1/me");
    set({ me, status: "signedIn" });
  },

  refreshMe: async () => {
    try {
      const me = await api.get<MeResponse>("/v1/me");
      set({ me });
      return me;
    } catch {
      return get().me;
    }
  },

  signOut: async () => {
    await unregisterPush();
    await api.post("/v1/auth/logout").catch(() => undefined);
    await tokenStore.clear();
    set({ status: "signedOut", me: null });
  },
}));

onSignedOut(() => useSession.setState({ status: "signedOut", me: null }));
