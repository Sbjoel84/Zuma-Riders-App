import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { Pressable, ScrollView, Share, View } from "react-native";
import { api, errorMessage } from "./api";
import { naira } from "./format";
import { colors, space } from "./theme";
import { Banner, Button, Card, Divider, Field, Muted, Pill, Row, Screen, Txt } from "./ui";

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <Row style={{ paddingVertical: space.md }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={{ paddingRight: space.sm }}>
        <Txt variant="title">‹</Txt>
      </Pressable>
      <Txt variant="title">{title}</Txt>
    </Row>
  );
}

interface Contact { id: string; name: string; phone: string; relationship: string | null }

/** Up to three people who get a text when you press SOS, and who you can share live trips with. */
export function EmergencyContactsScreen({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["contacts"], queryFn: () => api.get<Contact[]>("/v1/me/emergency-contacts") });
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(["contacts"], await api.post<Contact[]>("/v1/me/emergency-contacts", { name: name.trim(), phone }));
      setName("");
      setPhone("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    qc.setQueryData(["contacts"], await api.delete<Contact[]>(`/v1/me/emergency-contacts/${id}`).catch(() => q.data));
  };

  const list = q.data ?? [];
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingBottom: space.xxl }} keyboardShouldPersistTaps="handled">
        <Header title="Emergency contacts" onBack={onBack} />
        <Muted variant="body">When you press SOS, Zuma texts these people your location and trip details. You can also send them a live link to follow your trip.</Muted>
        {list.map((c) => (
          <Card key={c.id} style={{ padding: space.md }}>
            <Row style={{ justifyContent: "space-between" }}>
              <View style={{ flex: 1 }}>
                <Txt variant="label">{c.name}</Txt>
                <Muted>{c.phone}</Muted>
              </View>
              <Button title="Remove" kind="danger" onPress={() => remove(c.id)} style={{ minHeight: 40 }} />
            </Row>
          </Card>
        ))}
        {list.length < 3 ? (
          <Card>
            <Txt variant="label">Add a contact</Txt>
            <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Chioma (sister)" maxLength={60} />
            <Field label="Phone number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="0803 123 4567" />
            {error ? <Banner text={error} /> : null}
            <Button title="Save contact" onPress={add} loading={busy} disabled={name.trim().length < 2 || phone.replace(/\D/g, "").length < 10} />
          </Card>
        ) : <Muted>You've added the maximum of 3 contacts.</Muted>}
      </ScrollView>
    </Screen>
  );
}

interface ReferralSummary { code: string; reward: string; howItWorks: string; earned: string; referrals: { name: string; status: string; joinedAt: string }[] }

export function InviteScreen({ onBack, appName }: { onBack: () => void; appName: string }) {
  const q = useQuery({ queryKey: ["referrals"], queryFn: () => api.get<ReferralSummary>("/v1/me/referrals") });
  const share = () => {
    if (!q.data) return;
    void Share.share({ message: `Get around Abuja with ${appName}. You set the fare. Sign up with my code ${q.data.code} and we both get ${naira(q.data.reward)} after your first ride.` });
  };
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingBottom: space.xxl }}>
        <Header title="Invite friends" onBack={onBack} />
        {q.data ? (
          <>
            <Card style={{ alignItems: "center", backgroundColor: colors.amberSoft, borderColor: colors.amber }}>
              <Muted>Your code</Muted>
              <Txt variant="display" style={{ letterSpacing: 2 }}>{q.data.code}</Txt>
              <Muted center variant="body">{q.data.howItWorks}</Muted>
            </Card>
            <Button title="Share my code" onPress={share} />
            <Row style={{ justifyContent: "space-between" }}>
              <Txt variant="label">Earned so far</Txt>
              <Txt variant="heading">{naira(q.data.earned)}</Txt>
            </Row>
            <Divider />
            {q.data.referrals.length === 0 ? <Muted>No one has joined with your code yet.</Muted> : null}
            {q.data.referrals.map((r, i) => (
              <Row key={i} style={{ justifyContent: "space-between" }}>
                <Txt>{r.name}</Txt>
                <Pill label={r.status === "REWARDED" ? "Rewarded" : r.status === "PENDING" ? "Waiting for first trip" : "Not eligible"} tone={r.status === "REWARDED" ? "green" : r.status === "PENDING" ? "amber" : "neutral"} />
              </Row>
            ))}
          </>
        ) : q.isError ? <Banner text={errorMessage(q.error)} /> : <Muted>Loading…</Muted>}
      </ScrollView>
    </Screen>
  );
}

interface Inbox { unread: number; data: { id: string; title: string | null; body: string; readAt: string | null; createdAt: string }[] }

export function NotificationsScreen({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["inbox"], queryFn: () => api.get<Inbox>("/v1/me/notifications") });
  React.useEffect(() => {
    if (q.data?.unread) void api.post("/v1/me/notifications/read-all").then(() => qc.invalidateQueries({ queryKey: ["inbox-count"] }));
  }, [q.data?.unread]);
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space.md, paddingBottom: space.xxl }}>
        <Header title="Notifications" onBack={onBack} />
        {q.data?.data.length === 0 ? <Muted>Nothing yet. Trip updates, payments and account news appear here.</Muted> : null}
        {q.data?.data.map((n) => (
          <Card key={n.id} style={{ padding: space.md, gap: 4, borderColor: n.readAt ? undefined : colors.amber }}>
            <Txt variant="label">{n.title}</Txt>
            <Muted variant="body">{n.body}</Muted>
            <Muted>{new Date(n.createdAt).toLocaleString("en-NG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</Muted>
          </Card>
        ))}
      </ScrollView>
    </Screen>
  );
}
