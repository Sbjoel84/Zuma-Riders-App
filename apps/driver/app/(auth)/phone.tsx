import { PhoneStep } from "@zuma/mobile-core";
import { router } from "expo-router";

export default function Phone() {
  return (
    <PhoneStep
      title="Drive with Zuma"
      subtitle="Set your own price on every trip. Sign in with your phone number to get started."
      onSent={(otpId, phone) => router.push({ pathname: "/(auth)/otp", params: { otpId, phone } })}
    />
  );
}
