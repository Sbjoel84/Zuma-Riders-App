import { PhoneStep } from "@zuma/mobile-core";
import { router } from "expo-router";

export default function Phone() {
  return (
    <PhoneStep
      title="Ride at your price"
      subtitle="Offer a fare, choose your driver. Sign in with your phone number to get started."
      onSent={(otpId, phone) => router.push({ pathname: "/(auth)/otp", params: { otpId, phone } })}
    />
  );
}
