import { EmergencyContactsScreen } from "@zuma/mobile-core";
import { router } from "expo-router";

export default function Screen() {
  return <EmergencyContactsScreen onBack={() => router.back()} />;
}
