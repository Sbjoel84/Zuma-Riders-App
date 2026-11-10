import { TripChat } from "@zuma/mobile-core";
import { router, useLocalSearchParams } from "expo-router";

const QUICK = ["I'm at the pickup point", "I'm coming out now", "Where are you?", "Please wait 2 minutes", "I'm wearing a red top"];

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TripChat rideId={id} quickReplies={QUICK} onBack={() => router.back()} />;
}
