import { TripChat } from "@zuma/mobile-core";
import { router, useLocalSearchParams } from "expo-router";

const QUICK = ["I'm on my way", "I've arrived", "I'm in front of the gate", "Traffic is heavy, 5 more minutes", "Please come out"];

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TripChat rideId={id} quickReplies={QUICK} onBack={() => router.back()} />;
}
