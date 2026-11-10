import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DriverRequestView, EarningsView, RideView, WalletView } from "@zuma/contracts";
import { ApiRequestError, api, Banner, Button, Card, clock, colors, errorMessage, km, minutes, Muted, naira, Pill, Row, Screen, secondsLeft, space, Txt, useRealtimeConnected, useServerEvent, useSession } from "@zuma/mobile-core";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Redirect, router } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { currentPosition, requestPermissions, startTracking, stopTracking } from "../../src/location";

const STEP = 50000n; // ₦500 counter-offer steps

export default function Home() {
  const qc = useQueryClient();
  const signOut = useSession((s) => s.signOut);
  const connected = useRealtimeConnected();
  const [online, setOnline] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, tick] = useState(0);

  const driver = useQuery({ queryKey: ["driver-me"], queryFn: () => api.get<{ availability: string; ratingAvg: string; tripsCompleted: number }>("/v1/driver/me") });
  const earnings = useQuery({ queryKey: ["earnings", "day"], queryFn: () => api.get<EarningsView>("/v1/driver/earnings?period=day") });
  const wallet = useQuery({ queryKey: ["driver-wallet"], queryFn: () => api.get<WalletView>("/v1/driver/wallet") });
  const current = useQuery({ queryKey: ["current"], queryFn: () => api.get<{ ride: RideView | null }>("/v1/rides/current") });
  const requests = useQuery({
    queryKey: ["requests"],
    enabled: online,
    queryFn: () => api.get<DriverRequestView[]>("/v1/driver/ride-requests"),
    refetchInterval: online ? (connected ? 20_000 : 5_000) : false,
  });

  useEffect(() => {
    if (driver.data) setOnline(driver.data.availability === "ONLINE" || driver.data.availability === "ON_TRIP");
  }, [driver.data?.availability]);

  // Resume tracking if the app restarted while online.
  useEffect(() => {
    if (online) startTracking().catch(() => undefined);
  }, [online]);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useServerEvent<DriverRequestView>("ride_request.new", (r) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    qc.setQueryData<DriverRequestView[]>(["requests"], (old) => [r, ...(old ?? []).filter((x) => x.requestId !== r.requestId)]);
  });
  useServerEvent<DriverRequestView>("ride_request.updated", (r) => {
    qc.setQueryData<DriverRequestView[]>(["requests"], (old) => (old ?? []).map((x) => (x.requestId === r.requestId ? r : x)));
  });
  useServerEvent<{ requestId: string; reason: string }>("ride_request.closed", (e) => {
    qc.setQueryData<DriverRequestView[]>(["requests"], (old) => (old ?? []).filter((x) => x.requestId !== e.requestId));
  });
  useServerEvent<{ requestId: string; result: string }>("offer.result", (e) => {
    if (e.result === "REJECTED") {
      setNotice("The passenger chose another driver.");
      qc.setQueryData<DriverRequestView[]>(["requests"], (old) => (old ?? []).filter((x) => x.requestId !== e.requestId));
    }
  });
  useServerEvent<{ rideId: string }>("ride.assigned", (e) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    router.replace({ pathname: "/(app)/trip/[id]", params: { id: e.rideId } });
  });
  useServerEvent<{ reason: string }>("driver.forced_offline", (e) => {
    setOnline(false);
    stopTracking().catch(() => undefined);
    setError(e.reason === "HEARTBEAT_LOST" ? "You went offline because we lost your location. Go online again." : "You were taken offline by Zuma. Check your account status.");
  });

  if (current.data?.ride) return <Redirect href={{ pathname: "/(app)/trip/[id]", params: { id: current.data.ride.id } }} />;

  const toggle = async () => {
    setToggling(true);
    setError(null);
    try {
      if (online) {
        await api.post("/v1/driver/availability/offline");
        await stopTracking();
        setOnline(false);
        qc.setQueryData(["requests"], []);
      } else {
        const perm = await requestPermissions();
        if (perm === "denied") throw new Error("Location permission is needed to go online. Turn it on in Settings.");
        const pos = await currentPosition();
        await api.post("/v1/driver/availability/online", pos);
        await startTracking().catch(() => setNotice(perm === "foreground-only" ? "Keep Zuma open: background location is off, so you'll go offline if you leave the app." : null));
        if (perm === "foreground-only") setNotice("Keep Zuma open: background location is off, so you'll go offline if you leave the app.");
        setOnline(true);
        requests.refetch();
      }
      qc.invalidateQueries({ queryKey: ["driver-me"] });
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : errorMessage(e));
    } finally {
      setToggling(false);
    }
  };

  const list = (requests.data ?? []).filter((r) => secondsLeft(r.expiresAt) > 0);

  return (
    <Screen>
      <View style={{ flex: 1, gap: space.md, paddingTop: space.md }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Pressable accessibilityRole="switch" accessibilityState={{ checked: online }} onPress={toggle} disabled={toggling} style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: online ? colors.green : colors.nightLine, paddingHorizontal: 16, minHeight: 44, borderRadius: 22, opacity: toggling ? 0.6 : 1 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: online ? "#fff" : colors.nightMuted }} />
            <Txt variant="label" color="#fff">{toggling ? "…" : online ? "Online" : "Offline"}</Txt>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Open wallet and earnings" onPress={() => router.push("/(app)/wallet")} style={{ alignItems: "flex-end" }}>
            <Txt variant="title">{naira(earnings.data?.net ?? "0")}</Txt>
            <Muted>Today · {earnings.data?.trips ?? 0} trips · ★ {driver.data?.ratingAvg ?? "—"} · Wallet ›</Muted>
          </Pressable>
        </Row>

        {error ? <Banner text={error} /> : null}
        {notice ? <Banner tone="amber" text={notice} /> : null}
        {online && !connected ? <Banner tone="amber" text="Reconnecting… new requests may be delayed." /> : null}
        {wallet.data && BigInt(wallet.data.availableBalance) < 0n ? (
          <Banner tone={BigInt(wallet.data.availableBalance) < -BigInt(wallet.data.negativeLimit) ? "red" : "amber"} text={`You owe ${naira((-BigInt(wallet.data.availableBalance)).toString())} in cash-trip commission. Limit ${naira(wallet.data.negativeLimit)}.`} />
        ) : null}

        {!online ? (
          <View style={{ flex: 1, justifyContent: "center", gap: space.lg }}>
            <Txt variant="display" center>You're offline</Txt>
            <Muted variant="body" center>Go online to receive ride requests near you. You choose which trips to take and at what price.</Muted>
            <Button title="Go online" kind="amber" onPress={toggle} loading={toggling} />
            <Button title="Wallet and earnings" kind="secondary" onPress={() => router.push("/(app)/wallet")} />
            <Row gap={space.sm}>
              <Button title="Documents" kind="secondary" style={{ flex: 1 }} onPress={() => router.push("/(app)/documents")} />
              <Button title="Invite drivers" kind="secondary" style={{ flex: 1 }} onPress={() => router.push("/(app)/invite")} />
            </Row>
            <Row gap={space.sm}>
              <Button title="Emergency contacts" kind="ghost" style={{ flex: 1 }} onPress={() => router.push("/(app)/contacts")} />
              <Button title="Notifications" kind="ghost" style={{ flex: 1 }} onPress={() => router.push("/(app)/notifications")} />
            </Row>
            <Button title="Help and support" kind="ghost" onPress={() => router.push("/(app)/report")} />
            <Button title="Sign out" kind="ghost" onPress={signOut} />
          </View>
        ) : (
          <FlatList
            data={list}
            keyExtractor={(r) => r.requestId}
            contentContainerStyle={{ gap: space.md, paddingBottom: space.xxl }}
            ListEmptyComponent={
              <View style={{ paddingTop: space.xxl * 2, gap: space.sm }}>
                <Txt variant="heading" center>Waiting for requests</Txt>
                <Muted center>New ride requests near you will appear here. Keep the app open for the fastest alerts.</Muted>
              </View>
            }
            renderItem={({ item }) => <RequestCard r={item} onDone={(msg) => { setNotice(msg); requests.refetch(); }} />}
          />
        )}
      </View>
    </Screen>
  );
}

function RequestCard({ r, onDone }: { r: DriverRequestView; onDone: (msg: string | null) => void }) {
  const qc = useQueryClient();
  const proposed = BigInt(r.proposedFare);
  const max = BigInt(r.maxCounter);
  const options = [proposed + STEP, proposed + 2n * STEP, proposed + 3n * STEP].filter((x) => x <= max);
  const [counter, setCounter] = useState<bigint | null>(options[0] ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const left = secondsLeft(r.expiresAt);

  const send = async (body: object, label: string) => {
    setBusy(label);
    setError(null);
    try {
      const updated = await api.post<DriverRequestView>(`/v1/ride-requests/${r.requestId}/offers`, body, Crypto.randomUUID());
      qc.setQueryData<DriverRequestView[]>(["requests"], (old) => (old ?? []).map((x) => (x.requestId === r.requestId ? updated : x)));
      onDone("Offer sent. You'll be notified if the passenger picks you.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const skip = async () => {
    await api.post(`/v1/ride-requests/${r.requestId}/decline`).catch(() => undefined);
    qc.setQueryData<DriverRequestView[]>(["requests"], (old) => (old ?? []).filter((x) => x.requestId !== r.requestId));
  };

  return (
    <Card style={{ backgroundColor: "#fff", borderColor: "#fff" }}>
      <Row style={{ justifyContent: "space-between" }}>
        <Muted style={{ color: colors.muted }}>NEW REQUEST · {r.categoryKey.toUpperCase()}</Muted>
        <Txt variant="label" color={colors.amberText}>{clock(left)}</Txt>
      </Row>
      <Row style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <View>
          <Muted style={{ color: colors.muted }}>Passenger offers</Muted>
          <Txt variant="display" color={colors.ink}>{naira(r.proposedFare)}</Txt>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Txt variant="label" color={colors.ink}>{r.passenger.firstName} · ★ {r.passenger.ratingAvg}</Txt>
          <Txt variant="label" color={r.paymentMethod === "CASH" ? colors.green : colors.blue}>{r.paymentMethod === "CASH" ? "Cash" : r.paymentMethod === "CARD" ? "Card" : "Wallet"}</Txt>
        </View>
      </Row>
      <View style={{ gap: 4 }}>
        <Txt color={colors.ink}><Txt variant="label" color={colors.ink}>{r.pickup.area}</Txt>{r.distanceToPickupM !== null ? `  · ${km(r.distanceToPickupM)} to pickup` : ""}</Txt>
        <Txt color={colors.ink}><Txt variant="label" color={colors.ink}>{r.dropoffArea}</Txt>  · {km(r.distanceM)}, {minutes(r.durationS)}</Txt>
      </View>

      {error ? <Banner text={error} /> : null}

      {r.myOffer && r.myOffer.status === "PENDING" ? (
        <Row style={{ justifyContent: "space-between" }}>
          <Pill label={`You offered ${naira(r.myOffer.amount)}`} tone="amber" />
          <Button title="Withdraw" kind="secondary" style={{ minHeight: 40, borderColor: colors.line }} onPress={async () => { await api.post(`/v1/ride-requests/${r.requestId}/offers/mine/withdraw`).catch(() => undefined); onDone(null); }} />
        </Row>
      ) : (
        <>
          <Button title={`Accept for ${naira(r.proposedFare)}`} style={{ backgroundColor: colors.ink, borderColor: colors.ink }} loading={busy === "accept"} disabled={!!busy} onPress={() => send({ acceptPassengerPrice: true }, "accept")} />
          {options.length ? (
            <>
              <Muted style={{ color: colors.muted }}>Or offer your price</Muted>
              <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: space.sm }}>
                {options.map((o) => (
                  <Pressable key={o.toString()} accessibilityRole="radio" accessibilityState={{ checked: counter === o }} onPress={() => setCounter(o)} style={{ flex: 1, minHeight: 46, borderRadius: 12, borderWidth: 2, alignItems: "center", justifyContent: "center", borderColor: counter === o ? colors.amber : colors.line, backgroundColor: counter === o ? colors.amberSoft : "#fff" }}>
                    <Txt variant="label" color={colors.ink}>{naira(o)}</Txt>
                  </Pressable>
                ))}
              </View>
              <Row>
                <Button title="Skip" kind="secondary" style={{ flex: 1, borderColor: colors.line }} onPress={skip} />
                <Button title={`Offer ${counter ? naira(counter) : ""}`} kind="amber" style={{ flex: 2 }} loading={busy === "counter"} disabled={!!busy || !counter} onPress={() => counter && send({ amount: counter.toString() }, "counter")} />
              </Row>
            </>
          ) : (
            <Button title="Skip" kind="secondary" style={{ borderColor: colors.line }} onPress={skip} />
          )}
        </>
      )}
    </Card>
  );
}
