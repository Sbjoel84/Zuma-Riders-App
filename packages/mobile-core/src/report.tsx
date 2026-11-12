import React, { useState } from "react";
import { ScrollView, View } from "react-native";
import { api, errorMessage } from "./api";
import { space } from "./theme";
import { Banner, Button, Chip, Field, Muted, Screen, Txt } from "./ui";

const CATEGORIES = [
  { key: "TRIP_ISSUE", label: "Trip problem" },
  { key: "PAYMENT", label: "Payment" },
  { key: "LOST_PROPERTY", label: "Lost item" },
  { key: "SAFETY", label: "Safety" },
  { key: "ACCOUNT", label: "Account" },
  { key: "OTHER", label: "Other" },
] as const;

/** Shared "report a problem" form for both apps. Creates a support ticket the ops desk sees immediately. */
export function ReportProblem({ rideId, onDone }: { rideId?: string; onDone: () => void }) {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]["key"]>(rideId ? "TRIP_ISSUE" : "OTHER");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const submit = async () => {
    if (subject.trim().length < 3) return setError("Add a short title");
    if (body.trim().length < 3) return setError("Tell us what happened");
    setBusy(true);
    setError(null);
    try {
      const t = await api.post<{ number: string }>("/v1/support/tickets", { category, subject: subject.trim(), body: body.trim(), rideId });
      setSent(t.number);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: "center", gap: space.lg }}>
          <Txt variant="title">We've got it</Txt>
          <Muted variant="body">Your reference is {sent}. Riders App Support will reply in the app.{category === "SAFETY" ? " If you are in danger now, call 112." : ""}</Muted>
          <Button title="Done" onPress={onDone} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.xl }} keyboardShouldPersistTaps="handled">
        <Txt variant="title">Report a problem</Txt>
        {rideId ? <Muted>About your last trip</Muted> : null}
        <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {CATEGORIES.map((c) => (
            <View key={c.key} style={{ width: "31%" }}>
              <Chip label={c.label} selected={category === c.key} onPress={() => setCategory(c.key)} />
            </View>
          ))}
        </View>
        <Field label="Title" value={subject} onChangeText={setSubject} placeholder="e.g. Charged twice for one trip" maxLength={120} />
        <Field label="What happened?" value={body} onChangeText={setBody} multiline numberOfLines={5} style={{ minHeight: 120 }} maxLength={2000} />
        {error ? <Banner text={error} /> : null}
        <Button title="Send to Riders App Support" onPress={submit} loading={busy} />
        <Button title="Cancel" kind="ghost" onPress={onDone} />
      </ScrollView>
    </Screen>
  );
}
