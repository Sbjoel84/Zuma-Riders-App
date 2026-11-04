import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { normalizeNigerianPhone } from "@zuma/contracts";
import { api, errorMessage } from "./api";
import { useSession } from "./session";
import { space } from "./theme";
import { Banner, Button, Field, Muted, Screen, Txt } from "./ui";

/** Shared sign-in flow used by both apps. Each app's route files render these and handle navigation. */

export function PhoneStep({ title, subtitle, onSent }: { title: string; subtitle: string; onSent: (otpId: string, phone: string) => void }) {
  const requestOtp = useSession((s) => s.requestOtp);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const normalized = normalizeNigerianPhone(phone);
    if (!normalized) return setError("Enter a valid phone number, e.g. 0803 123 4567");
    setBusy(true);
    setError(null);
    try {
      const r = await requestOtp(normalized);
      onSent(r.otpId, normalized);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View style={{ flex: 1, justifyContent: "center", gap: space.lg }}>
          <Txt variant="display">{title}</Txt>
          <Muted variant="body">{subtitle}</Muted>
          <Field label="Phone number" placeholder="0803 123 4567" keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" value={phone} onChangeText={setPhone} error={error} onSubmitEditing={submit} />
          <Button title="Send code" onPress={submit} loading={busy} />
          <Muted center>We'll text you a 6-digit code. Standard SMS rates may apply.</Muted>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

export function OtpStep({ otpId: initialId, phone, onBack }: { otpId: string; phone: string; onBack: () => void }) {
  const { verifyOtp, requestOtp } = useSession();
  const [otpId, setOtpId] = useState(initialId);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(60);

  useEffect(() => {
    const t = setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const submit = async (value = code) => {
    if (!/^\d{6}$/.test(value)) return setError("Enter the 6-digit code");
    setBusy(true);
    setError(null);
    try {
      await verifyOtp(otpId, value);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const resend = async () => {
    try {
      const r = await requestOtp(phone);
      setOtpId(r.otpId);
      setWait(r.resendAfterS);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", gap: space.lg }}>
        <Txt variant="title">Enter the code</Txt>
        <Muted variant="body">Sent to {phone}</Muted>
        <Field
          label="6-digit code"
          placeholder="••••••"
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          maxLength={6}
          value={code}
          onChangeText={(v) => {
            const digits = v.replace(/\D/g, "");
            setCode(digits);
            if (digits.length === 6) submit(digits);
          }}
          error={error}
        />
        <Button title="Verify" onPress={() => submit()} loading={busy} />
        <Button title={wait > 0 ? `Resend code in ${wait}s` : "Resend code"} kind="ghost" disabled={wait > 0} onPress={resend} />
        <Button title="Change number" kind="ghost" onPress={onBack} />
      </View>
    </Screen>
  );
}

export function ProfileStep({ onDone, intro }: { onDone: () => void; intro: string }) {
  const refreshMe = useSession((s) => s.refreshMe);
  const me = useSession((s) => s.me);
  const [firstName, setFirst] = useState(me?.firstName ?? "");
  const [lastName, setLast] = useState(me?.lastName ?? "");
  const [email, setEmail] = useState(me?.email ?? "");
  const [referral, setReferral] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!firstName.trim() || !lastName.trim()) return setError("Enter your first and last name");
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/me/profile", { firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim() || undefined, referralCode: referral.trim() || undefined, termsVersion: "2026-11", marketingConsent: false });
      await refreshMe();
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingVertical: space.xxl, gap: space.lg }} keyboardShouldPersistTaps="handled">
        <Txt variant="title">About you</Txt>
        <Muted variant="body">{intro}</Muted>
        {error ? <Banner text={error} /> : null}
        <Field label="First name" value={firstName} onChangeText={setFirst} autoComplete="given-name" />
        <Field label="Last name" value={lastName} onChangeText={setLast} autoComplete="family-name" />
        <Field label="Email (optional)" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" hint="For receipts" />
        <Field label="Referral code (optional)" value={referral} onChangeText={setReferral} autoCapitalize="characters" />
        <Muted>By continuing you agree to the Terms of Service and Privacy Policy, including how we use your location during trips.</Muted>
        <Button title="Continue" onPress={submit} loading={busy} />
      </ScrollView>
    </Screen>
  );
}
