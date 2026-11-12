import { InviteScreen } from "@zuma/mobile-core";
import { router } from "expo-router";

export default function Screen() {
  return <InviteScreen appName="Riders App Driver" onBack={() => router.back()} />;
}
