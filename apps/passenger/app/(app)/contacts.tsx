import { EmergencyContactsScreen } from "@zuma/mobile-core";
import { router } from "expo-router";

export default function Contacts() {
  return <EmergencyContactsScreen onBack={() => router.back()} />;
}
