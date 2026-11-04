import { OtpStep, useSession } from "@zuma/mobile-core";
import { Redirect, router, useLocalSearchParams } from "expo-router";

export default function Otp() {
  const { otpId, phone } = useLocalSearchParams<{ otpId: string; phone: string }>();
  const status = useSession((s) => s.status);
  if (status === "signedIn") return <Redirect href="/" />;
  return <OtpStep otpId={otpId!} phone={phone!} onBack={() => router.back()} />;
}
