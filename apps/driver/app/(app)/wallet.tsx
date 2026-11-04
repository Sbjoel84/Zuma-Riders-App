import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EarningsView, WalletView } from "@zuma/contracts";
import { api, Banner, Button, Card, Chip, errorMessage, Field, Loading, Muted, naira, Pill, Row, Screen, space, Txt } from "@zuma/mobile-core";
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

interface Bank { bankName: string; accountName: string; last4: string }
interface Withdrawal { id: string; amount: string; status: string; bank: string; rejectionReason: string | null; createdAt: string }

const STATUS: Record<string, { label: string; tone: "amber" | "blue" | "green" | "red" | "neutral" }> = {
  REQUESTED: { label: "Requested", tone: "amber" },
  APPROVED: { label: "Approved, transfer on the way", tone: "blue" },
  COMPLETED: { label: "Paid", tone: "green" },
  REJECTED: { label: "Rejected", tone: "red" },
};

export default function Wallet() {
  const qc = useQueryClient();
  const [period, setPeriod] = useState<"day" | "week" | "month">("week");
  const wallet = useQuery({ queryKey: ["driver-wallet"], queryFn: () => api.get<WalletView>("/v1/driver/wallet") });
  const earnings = useQuery({ queryKey: ["earnings", period], queryFn: () => api.get<EarningsView>(`/v1/driver/earnings?period=${period}`) });
  const bank = useQuery({ queryKey: ["bank"], queryFn: () => api.get<Bank | null>("/v1/driver/bank-account") });
  const withdrawals = useQuery({ queryKey: ["withdrawals"], queryFn: () => api.get<Withdrawal[]>("/v1/driver/withdrawals") });

  const [editBank, setEditBank] = useState(false);
  const [bankName, setBankName] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const withdrawKey = useRef(Crypto.randomUUID());

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["driver-wallet"] });
    qc.invalidateQueries({ queryKey: ["withdrawals"] });
    qc.invalidateQueries({ queryKey: ["bank"] });
  };

  if (wallet.isLoading) return <Screen><Loading /></Screen>;
  const w = wallet.data;
  const available = w ? BigInt(w.availableBalance) : 0n;
  const open = withdrawals.data?.some((x) => x.status === "REQUESTED" || x.status === "APPROVED");

  const saveBank = async () => {
    setBusy("bank");
    setError(null);
    try {
      await api.put("/v1/driver/bank-account", { bankName: bankName.trim(), accountName: accountName.trim(), accountNumber: accountNumber.trim() });
      setEditBank(false);
      setNotice("Bank account saved.");
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async () => {
    const naira = amount.replace(/[,\s₦]/g, "");
    if (!/^\d+$/.test(naira)) return setError("Enter a whole naira amount, e.g. 5000");
    setBusy("withdraw");
    setError(null);
    try {
      await api.post("/v1/driver/withdrawals", { amount: (BigInt(naira) * 100n).toString() }, withdrawKey.current);
      withdrawKey.current = Crypto.randomUUID();
      setAmount("");
      setNotice("Withdrawal requested. Zuma finance reviews payouts on working days.");
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={wallet.isFetching} onRefresh={refresh} tintColor="#f2a900" />}>
        <Row style={{ justifyContent: "space-between" }}>
          <Txt variant="title">Wallet and earnings</Txt>
          <Button title="Close" kind="ghost" onPress={() => router.back()} />
        </Row>
        {notice ? <Banner tone="green" text={notice} /> : null}
        {error ? <Banner text={error} /> : null}

        <Card>
          <Muted>Available to withdraw</Muted>
          <Txt variant="display" color={available < 0n ? "#b3261e" : undefined}>{naira(w?.availableBalance)}</Txt>
          <Row style={{ justifyContent: "space-between" }}>
            <Muted>Pending (24-hour hold): {naira(w?.pendingBalance)}</Muted>
            <Muted>In payout: {naira(w?.heldBalance)}</Muted>
          </Row>
          {available < 0n ? <Muted>You owe this in cash-trip commission. It's taken from your next wallet earnings.</Muted> : null}
        </Card>

        <Card>
          <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: space.sm }}>
            {(["day", "week", "month"] as const).map((p) => <Chip key={p} label={p === "day" ? "Today" : p === "week" ? "This week" : "This month"} selected={period === p} onPress={() => setPeriod(p)} />)}
          </View>
          {earnings.data ? (
            <View style={{ gap: 6 }}>
              <Row style={{ justifyContent: "space-between" }}><Muted>Trips</Muted><Txt variant="label">{earnings.data.trips}</Txt></Row>
              <Row style={{ justifyContent: "space-between" }}><Muted>Fares</Muted><Txt variant="label">{naira(earnings.data.gross)}</Txt></Row>
              <Row style={{ justifyContent: "space-between" }}><Muted>Zuma commission</Muted><Txt variant="label">−{naira(earnings.data.commission)}</Txt></Row>
              <Row style={{ justifyContent: "space-between" }}><Txt variant="label">You earned</Txt><Txt variant="heading">{naira(earnings.data.net)}</Txt></Row>
              <Muted>Cash collected from passengers: {naira(earnings.data.cashCollected)}</Muted>
            </View>
          ) : <Loading />}
        </Card>

        <Card>
          <Txt variant="heading">Bank account</Txt>
          {bank.data && !editBank ? (
            <Row style={{ justifyContent: "space-between" }}>
              <View><Txt variant="label">{bank.data.bankName} ••{bank.data.last4}</Txt><Muted>{bank.data.accountName}</Muted></View>
              <Button title="Change" kind="secondary" onPress={() => { setEditBank(true); setBankName(bank.data!.bankName); setAccountName(bank.data!.accountName); }} />
            </Row>
          ) : (
            <>
              <Field label="Bank" value={bankName} onChangeText={setBankName} placeholder="GTBank" />
              <Field label="Account name" value={accountName} onChangeText={setAccountName} placeholder="As it appears on your account" />
              <Field label="Account number" value={accountNumber} onChangeText={(v) => setAccountNumber(v.replace(/\D/g, ""))} keyboardType="number-pad" maxLength={10} hint="10-digit NUBAN" />
              <Button title="Save bank account" onPress={saveBank} loading={busy === "bank"} />
            </>
          )}
        </Card>

        {bank.data ? (
          <Card>
            <Txt variant="heading">Withdraw</Txt>
            {open ? <Muted>You have a withdrawal in progress. You can request another once it's paid.</Muted> : (
              <>
                <Field label="Amount (₦)" value={amount} onChangeText={setAmount} keyboardType="number-pad" hint={`Minimum ₦1,000 · up to ${naira(available > 0n ? available : 0n)}`} />
                <Button title="Request withdrawal" kind="amber" onPress={withdraw} loading={busy === "withdraw"} disabled={available < 100000n} />
              </>
            )}
          </Card>
        ) : null}

        {withdrawals.data?.length ? (
          <Card>
            <Txt variant="heading">Withdrawals</Txt>
            {withdrawals.data.map((x) => (
              <Row key={x.id} style={{ justifyContent: "space-between" }}>
                <View style={{ flex: 1 }}>
                  <Txt variant="label">{naira(x.amount)}</Txt>
                  <Muted>{new Date(x.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · {x.bank}{x.rejectionReason ? ` · ${x.rejectionReason}` : ""}</Muted>
                </View>
                <Pill label={STATUS[x.status]?.label ?? x.status} tone={STATUS[x.status]?.tone ?? "neutral"} />
              </Row>
            ))}
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
