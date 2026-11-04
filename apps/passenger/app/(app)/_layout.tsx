import { useSession } from "@zuma/mobile-core";
import { Redirect, Stack } from "expo-router";

export default function AppLayout() {
  const status = useSession((s) => s.status);
  if (status === "signedOut") return <Redirect href="/(auth)/phone" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#f4f5f1" } }} />;
}
