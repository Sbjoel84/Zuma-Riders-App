import { InviteScreen } from "@zuma/mobile-core";
import { router } from "expo-router";

export default function Invite() {
  return <InviteScreen appName="Zuma" onBack={() => router.back()} />;
}
