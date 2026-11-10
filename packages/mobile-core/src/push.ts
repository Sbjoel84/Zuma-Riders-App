import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { api, request } from "./api";
import { installId } from "./storage";

let currentToken: string | null = null;

// Show notifications as banners even while the app is open (chat, offers when on another screen).
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/**
 * Asks for notification permission, creates the Android channels the API targets, and registers the
 * Expo push token with the API. Safe to call on every launch. Returns false when push is unavailable
 * (simulator, permission denied, no EAS project id yet).
 */
export async function registerForPush(): Promise<boolean> {
  if (!Device.isDevice) return false;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("rides", { name: "Ride requests and trip updates", importance: Notifications.AndroidImportance.MAX, sound: "default", vibrationPattern: [0, 300, 200, 300] });
    await Notifications.setNotificationChannelAsync("chat", { name: "Messages", importance: Notifications.AndroidImportance.HIGH, sound: "default" });
    await Notifications.setNotificationChannelAsync("default", { name: "Account and payments", importance: Notifications.AndroidImportance.DEFAULT });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return false;
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return false;
  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await api.post("/v1/me/push-tokens", { token, platform: Platform.OS === "ios" ? "IOS" : "ANDROID", installId: await installId() });
    currentToken = token;
    return true;
  } catch {
    return false;
  }
}

/** Called on sign-out so this phone stops receiving the account's notifications. */
export async function unregisterPush() {
  if (!currentToken) return;
  await request("DELETE", `/v1/me/push-tokens/${encodeURIComponent(currentToken)}`).catch(() => undefined);
  currentToken = null;
}

export type PushData = { type?: string; rideId?: string; requestId?: string; [k: string]: unknown };

/**
 * Registers for push once signed in and routes notification taps (including the one that launched
 * the app) to the handler.
 */
export function usePushNotifications(enabled: boolean, onOpen: (data: PushData) => void) {
  const handler = useRef(onOpen);
  handler.current = onOpen;
  useEffect(() => {
    if (!enabled) return;
    void registerForPush();
    Notifications.getLastNotificationResponseAsync().then((r) => {
      if (r) handler.current(r.notification.request.content.data as PushData);
    });
    const sub = Notifications.addNotificationResponseReceivedListener((r) => handler.current(r.notification.request.content.data as PushData));
    return () => sub.remove();
  }, [enabled]);
}
