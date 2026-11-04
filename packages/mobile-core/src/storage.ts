import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const ACCESS = "zuma.access";
const REFRESH = "zuma.refresh";
const INSTALL = "zuma.installId";

let accessCache: string | null = null;

/** Tokens live only in the Keychain / Android Keystore via expo-secure-store. */
export const tokenStore = {
  async getAccess() {
    if (accessCache) return accessCache;
    accessCache = await SecureStore.getItemAsync(ACCESS);
    return accessCache;
  },
  async getRefresh() {
    return SecureStore.getItemAsync(REFRESH);
  },
  async save(access: string, refresh: string) {
    accessCache = access;
    await SecureStore.setItemAsync(ACCESS, access);
    await SecureStore.setItemAsync(REFRESH, refresh);
  },
  async clear() {
    accessCache = null;
    await SecureStore.deleteItemAsync(ACCESS);
    await SecureStore.deleteItemAsync(REFRESH);
  },
};

/** Stable per-install identifier used for device/session management. */
export async function installId(): Promise<string> {
  let id = await SecureStore.getItemAsync(INSTALL);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(INSTALL, id);
  }
  return id;
}
