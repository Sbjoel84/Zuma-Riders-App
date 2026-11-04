import { Loading, Screen, useSession } from "@zuma/mobile-core";
import { Redirect } from "expo-router";

/** Entry gate: decides where the user lands. */
export default function Index() {
  const { status, me } = useSession();
  if (status === "loading") return <Screen><Loading /></Screen>;
  if (status === "signedOut") return <Redirect href="/(auth)/phone" />;
  if (me && !me.profileComplete) return <Redirect href="/(auth)/profile" />;
  return <Redirect href="/(app)/home" />;
}
