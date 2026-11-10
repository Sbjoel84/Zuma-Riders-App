import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { WalletView } from "@zuma/contracts";
import { api, Banner, Button, Card, Chip, colors, Divider, errorMessage, Field, Muted, naira, payByCard, Row, Screen, space, Txt, type SavedCard } from "@zuma/mobile-core";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

const AMOUNTS = ["100000", "200000", "500000", "1000000"]; // ₦1,000 … ₦10,000

interface Txn { id: string; type: string; direction: "CREDIT" | "DEBIT"; amount: string; description: string; createdAt: string }

export default function Wallet() {
  const qc = useQueryClient();
  const wallet = useQuery({ queryKey: ["wallet"], queryFn: () => api.get<WalletView>("/v1/wallet") });
  const cards = useQuery({ queryKey: ["cards"], queryFn: () => api.get<SavedCard[]>("/v1/payments/cards") });
  const txns = useQuery({ queryKey: ["wallet-txns"], queryFn: () => api.get<{ data: Txn[] }>("/v1/wallet/transactions") });
  const [amount, setAmount] = useState(AMOUNTS[1]!);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "green" | "red" | "amber"; text: string } | null>(null);

  const refresh = () => ["wallet", "cards", "wallet-txns"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const kobo = custom ? String(Math.round(Number(custom.replace(/[^0-9.]/g, "")) * 100)) : amount;

  const topUp = async () => {
    if (!Number(kobo) || Number(kobo) < 10000) return setMsg({ tone: "red", text: "The minimum top-up is ₦100" });
    setBusy(true);
    setMsg(null);
    try {
      const p = await payByCard(kobo, "zuma");
      if (p.status === "SUCCEEDED") setMsg({ tone: "green", text: `${naira(p.amount)} added to your wallet.${p.card?.last4 ? ` Card ••${p.card.last4} is saved for card trips.` : ""}` });
      else if (p.status === "PENDING" || p.status === "INITIATED") setMsg({ tone: "amber", text: "We're waiting for your bank to confirm. Your balance updates automatically." });
      else setMsg({ tone: "red", text: p.failureReason ? `Payment didn't go through: ${p.failureReason}` : "Payment didn't go through. You were not charged." });
      refresh();
    } catch (e) {
      setMsg({ tone: "red", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const setDefault = async (id: string) => qc.setQueryData(["cards"], await api.put<SavedCard[]>(`/v1/payments/cards/${id}/default`));
  const remove = async (id: string) => qc.setQueryData(["cards"], await api.delete<SavedCard[]>(`/v1/payments/cards/${id}`));

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingBottom: space.xxl }} keyboardShouldPersistTaps="handled">
        <Row style={{ paddingVertical: space.md }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={{ paddingRight: space.sm }}>
            <Txt variant="title">‹</Txt>
          </Pressable>
          <Txt variant="title">Wallet</Txt>
        </Row>

        <Card style={{ backgroundColor: colors.ink, borderColor: colors.ink }}>
          <Muted style={{ color: "#a9b0a8" }}>Available balance</Muted>
          <Txt variant="display" color="#fff">{naira(wallet.data?.availableBalance)}</Txt>
          <Muted style={{ color: "#a9b0a8" }}>Pay for trips from your wallet, or with a saved card.</Muted>
        </Card>

        <View style={{ gap: space.sm }}>
          <Txt variant="label">Top up by card, bank transfer or USSD</Txt>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            {AMOUNTS.map((a) => <Chip key={a} label={naira(a)} selected={!custom && amount === a} onPress={() => { setAmount(a); setCustom(""); }} />)}
          </View>
          <Field label="Or enter an amount (₦)" value={custom} onChangeText={setCustom} keyboardType="numeric" placeholder="e.g. 3500" />
          {msg ? <Banner tone={msg.tone} text={msg.text} /> : null}
          <Button title={`Top up ${naira(kobo)}`} onPress={topUp} loading={busy} />
          <Muted center>Payments are processed securely by Paystack. Zuma never sees your card number.</Muted>
        </View>

        <View style={{ gap: space.sm }}>
          <Txt variant="label">Saved cards</Txt>
          {cards.data?.length ? cards.data.map((c) => (
            <Card key={c.id} style={{ padding: space.md }}>
              <Row style={{ justifyContent: "space-between" }}>
                <View style={{ flex: 1 }}>
                  <Txt variant="label">{(c.brand ?? "Card").toUpperCase()} ••{c.last4}</Txt>
                  <Muted>Expires {String(c.expMonth).padStart(2, "0")}/{String(c.expYear).slice(-2)}{c.isDefault ? " · used for card trips" : ""}</Muted>
                </View>
                {!c.isDefault ? <Button title="Use" kind="secondary" style={{ minHeight: 40 }} onPress={() => setDefault(c.id)} /> : null}
                <Button title="Remove" kind="danger" style={{ minHeight: 40 }} onPress={() => remove(c.id)} />
              </Row>
            </Card>
          )) : <Muted>No saved card yet. Your card is saved after your first card top-up.</Muted>}
        </View>

        <View style={{ gap: space.sm }}>
          <Txt variant="label">Recent activity</Txt>
          {txns.data?.data.length ? txns.data.data.map((t, i) => (
            <View key={t.id}>
              {i ? <Divider /> : null}
              <Row style={{ justifyContent: "space-between", paddingVertical: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Txt>{t.description}</Txt>
                  <Muted>{new Date(t.createdAt).toLocaleString("en-NG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</Muted>
                </View>
                <Txt variant="label" color={t.direction === "CREDIT" ? colors.green : undefined}>{t.direction === "CREDIT" ? "+" : "−"}{naira(t.amount)}</Txt>
              </Row>
            </View>
          )) : <Muted>No wallet activity yet.</Muted>}
        </View>
      </ScrollView>
    </Screen>
  );
}
