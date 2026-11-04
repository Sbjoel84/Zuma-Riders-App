import { ReportProblem } from "@zuma/mobile-core";
import { router, useLocalSearchParams } from "expo-router";

export default function Report() {
  const { rideId } = useLocalSearchParams<{ rideId?: string }>();
  return <ReportProblem rideId={rideId || undefined} onDone={() => router.back()} />;
}
