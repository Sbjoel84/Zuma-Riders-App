import { usePushNotifications, useSession } from "@zuma/mobile-core";
import { Redirect, router, Stack } from "expo-router";

export default function AppLayout() {
  const status = useSession((s) => s.status);
  // Notification taps open the right screen: a trip, the offers list, a chat or the wallet.
  usePushNotifications(status === "signedIn", (d) => {
    if (d.type === "ride" && d.rideId) router.push({ pathname: "/(app)/trip/[id]", params: { id: String(d.rideId) } });
    else if (d.type === "chat" && d.rideId) router.push({ pathname: "/(app)/chat/[id]", params: { id: String(d.rideId) } });
    else if (d.type === "offers" && d.requestId) router.push({ pathname: "/(app)/offers/[id]", params: { id: String(d.requestId) } });
    else if (d.type === "wallet") router.push("/(app)/wallet");
  });
  if (status === "signedOut") return <Redirect href="/(auth)/phone" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#f4f5f1" } }} />;
}
