import { ProfileStep } from "@zuma/mobile-core";
import { router } from "expo-router";

export default function Profile() {
  return <ProfileStep intro="Passengers see your first name, photo and rating when you send an offer." onDone={() => router.replace("/")} />;
}
