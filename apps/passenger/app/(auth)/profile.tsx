import { ProfileStep } from "@zuma/mobile-core";
import { router } from "expo-router";

export default function Profile() {
  return <ProfileStep intro="Drivers see your first name when you request a ride." onDone={() => router.replace("/(app)/home")} />;
}
