import { colors, usePushNotifications, useSession } from "@zuma/mobile-core";
import { Redirect, router, Stack } from "expo-router";

export default function AppLayout() {
  const status = useSession((s) => s.status);
  usePushNotifications(status === "signedIn", (d) => {
    if (d.type === "ride" && d.rideId) router.push({ pathname: "/(app)/trip/[id]", params: { id: String(d.rideId) } });
    else if (d.type === "chat" && d.rideId) router.push({ pathname: "/(app)/chat/[id]", params: { id: String(d.rideId) } });
    else if (d.type === "request") router.push("/(app)/home");
    else if (d.type === "wallet") router.push("/(app)/wallet");
    else if (d.type === "documents") router.push("/(app)/documents");
  });
  if (status === "signedOut") return <Redirect href="/(auth)/phone" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.night } }} />;
}
