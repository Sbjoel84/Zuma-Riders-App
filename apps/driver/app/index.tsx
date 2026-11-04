import { Loading, Screen, useSession } from "@zuma/mobile-core";
import { Redirect } from "expo-router";

export default function Index() {
  const { status, me } = useSession();
  if (status === "loading") return <Screen><Loading /></Screen>;
  if (status === "signedOut") return <Redirect href="/(auth)/phone" />;
  if (me && !me.profileComplete) return <Redirect href="/(auth)/profile" />;
  if (me && (!me.driver || me.driver.verificationStatus !== "APPROVED" || !me.driver.activeVehicleId)) return <Redirect href="/(app)/onboarding" />;
  return <Redirect href="/(app)/home" />;
}
