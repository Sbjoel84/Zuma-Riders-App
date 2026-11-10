import { InviteScreen } from "@zuma/mobile-core";
import { router } from "expo-router";

export default function Screen() {
  return <InviteScreen appName="Zuma Driver" onBack={() => router.back()} />;
}
