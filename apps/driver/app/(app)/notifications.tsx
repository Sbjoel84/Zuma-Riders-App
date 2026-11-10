import { NotificationsScreen } from "@zuma/mobile-core";
import { router } from "expo-router";

export default function Screen() {
  return <NotificationsScreen onBack={() => router.back()} />;
}
