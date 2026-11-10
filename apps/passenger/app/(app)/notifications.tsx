import { NotificationsScreen } from "@zuma/mobile-core";
import { router } from "expo-router";

export default function Notifications() {
  return <NotificationsScreen onBack={() => router.back()} />;
}
