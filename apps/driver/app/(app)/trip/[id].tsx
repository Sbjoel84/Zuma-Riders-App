import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RideView } from "@zuma/contracts";
import { ThemeContext, ApiRequestError, api, Banner, Button, Card, colors, errorMessage, Field, km, Loading, Muted, naira, Pill, radius, Row, Screen, space, Txt, useServerEvent } from "@zuma/mobile-core";
import * as Crypto from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import MapView, { Marker } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { currentPosition } from "../../../src/location";

/** Turn-by-turn is handed to Google Maps / Apple Maps (ADR-011). */
function navigate(lat: number, lng: number) {
  const url = Platform.OS === "ios" ? `maps://?daddr=${lat},${lng}&dirflg=d` : `google.navigation:q=${lat},${lng}&mode=d`;
  Linking.openURL(url).catch(() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`));
}

export default function DriverTrip() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const completeKey = useRef(Crypto.randomUUID());

  const ride = useQuery({ queryKey: ["ride", id], queryFn: () => api.get<RideView>(`/v1/rides/${id}`), refetchInterval: 15_000 });
  useServerEvent<{ rideId: string }>("ride.status", (e) => {
    if (e.rideId === id) qc.invalidateQueries({ queryKey: ["ride", id] });
  });
  useServerEvent<{ rideId: string; message: { fromMe: boolean } }>("chat.message", (e) => {
    if (e.rideId === id && !e.message.fromMe) qc.invalidateQueries({ queryKey: ["ride", id] });
  });

  if (ride.isLoading) return <Screen><Loading label="Loading trip…" /></Screen>;
  if (ride.isError || !ride.data) return <Screen><Banner text={errorMessage(ride.error)} /></Screen>;
  const r = ride.data;

  const act = async (label: string, fn: () => Promise<RideView>) => {
    setBusy(label);
    setError(null);
    try {
      const updated = await fn();
      qc.setQueryData(["ride", id], updated);
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "RIDE_STATE_CHANGED") qc.invalidateQueries({ queryKey: ["ride", id] });
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const enRoute = () => act("enroute", async () => {
    const v = await api.post<RideView>(`/v1/rides/${id}/en-route`);
    navigate(r.pickup.lat, r.pickup.lng);
    return v;
  });
  const arrived = () => act("arrived", async () => {
    await currentPosition().catch(() => undefined); // make sure the server has a fresh position for the geofence check
    return api.post<RideView>(`/v1/rides/${id}/arrived`);
  });
  const start = () => act("start", async () => {
    const v = await api.post<RideView>(`/v1/rides/${id}/start`, { pin });
    navigate(r.dropoff.lat, r.dropoff.lng);
    return v;
  });
  const complete = () => act("complete", async () => {
    const pos = await currentPosition().catch(() => ({ lat: r.dropoff.lat, lng: r.dropoff.lng }));
    // Same key on retries: a flaky network can never complete (and charge) a trip twice.
    return api.post<RideView>(`/v1/rides/${id}/complete`, pos, completeKey.current);
  });
  const cancel = () => act("cancel", () => api.post<RideView>(`/v1/rides/${id}/cancel`, { reasonCode: r.status === "DRIVER_ARRIVED" ? "PASSENGER_NO_SHOW" : "OTHER" }));

  if (r.status === "TRIP_COMPLETED" || r.status === "CANCELLED") {
    return <TripSummary ride={r} onDone={() => { qc.invalidateQueries(); router.replace("/(app)/home"); }} />;
  }

  const target = r.status === "TRIP_STARTED" ? r.dropoff : r.pickup;
  const stage: Record<string, string> = {
    DRIVER_SELECTED: "Head to pickup",
    DRIVER_EN_ROUTE: "Driving to pickup",
    DRIVER_ARRIVED: "Waiting for passenger",
    TRIP_STARTED: "Trip in progress",
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.night }}>
      <MapView style={StyleSheet.absoluteFill} initialRegion={{ latitude: target.lat, longitude: target.lng, latitudeDelta: 0.03, longitudeDelta: 0.03 }} showsUserLocation followsUserLocation toolbarEnabled={false}>
        <Marker coordinate={{ latitude: r.pickup.lat, longitude: r.pickup.lng }} title="Pickup" pinColor={colors.ink} />
        <Marker coordinate={{ latitude: r.dropoff.lat, longitude: r.dropoff.lng }} title="Destination" pinColor={colors.amber} />
      </MapView>

      <SafeAreaView edges={["top"]} style={{ position: "absolute", top: 0, left: space.lg, right: space.lg, paddingTop: space.sm }}>
        <View style={{ alignSelf: "flex-start", backgroundColor: colors.ink, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 22 }}>
          <Txt variant="label" color="#fff">{stage[r.status] ?? r.status}</Txt>
        </View>
      </SafeAreaView>

      {/* The trip sheet is white inside the dark driver app, so its controls use the light theme. */}
      <ThemeContext.Provider value={{ dark: false }}>
      <SafeAreaView edges={["bottom"]} style={styles.sheet}>
        <ScrollView contentContainerStyle={{ gap: space.lg }} keyboardShouldPersistTaps="handled">
          <Row style={{ justifyContent: "space-between" }}>
            <View style={{ flex: 1 }}>
              <Txt variant="heading" color={colors.ink}>{r.passenger.firstName} · ★ {r.passenger.ratingAvg}</Txt>
              <Muted style={{ color: colors.muted }}>{r.status === "TRIP_STARTED" ? "Drop-off" : "Pickup"}: {target.address}</Muted>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <Txt variant="title" color={colors.ink}>{naira(r.paymentMethod === "CASH" ? r.passengerPays : r.agreedFare)}</Txt>
              <Pill label={r.paymentMethod === "CASH" ? "Collect cash" : r.paymentMethod === "CARD" ? "Card" : "Wallet"} tone={r.paymentMethod === "CASH" ? "green" : "blue"} />
            </View>
          </Row>

          {r.paymentMethod === "CASH" && BigInt(r.discountAmount) > 0n ? (
            <Muted style={{ color: colors.muted }}>{r.passenger.firstName} has a promo: collect {naira(r.passengerPays)} in cash. Riders App adds the {naira(r.discountAmount)} discount to your wallet, so you still earn on {naira(r.agreedFare)}.</Muted>
          ) : null}
          <Row gap={space.sm}>
            <Button title={`Navigate to ${r.status === "TRIP_STARTED" ? "destination" : "pickup"}`} kind="secondary" style={{ flex: 1 }} onPress={() => navigate(target.lat, target.lng)} />
            <Button title={r.unreadMessages ? `Chat · ${r.unreadMessages}` : "Chat"} kind={r.unreadMessages ? "amber" : "secondary"} style={{ flex: 0.6 }} onPress={() => router.push({ pathname: "/(app)/chat/[id]", params: { id } })} />
          </Row>

          {error ? <Banner text={error} /> : null}

          {r.status === "DRIVER_SELECTED" ? <Button title="Start driving to pickup" loading={busy === "enroute"} onPress={enRoute} /> : null}
          {r.status === "DRIVER_SELECTED" || r.status === "DRIVER_EN_ROUTE" ? <Button title="I've arrived" kind="amber" loading={busy === "arrived"} onPress={arrived} /> : null}

          {r.status === "DRIVER_ARRIVED" ? (
            <Card style={{ backgroundColor: colors.amberSoft, borderColor: colors.amberSoft }}>
              <Txt variant="label" color={colors.ink}>Ask {r.passenger.firstName} for their 4-digit trip PIN</Txt>
              <Field label="Trip PIN" keyboardType="number-pad" maxLength={4} value={pin} onChangeText={(v) => setPin(v.replace(/\D/g, ""))} placeholder="••••" />
              <Button title="Start trip" disabled={pin.length !== 4} loading={busy === "start"} onPress={start} />
            </Card>
          ) : null}

          {r.status === "TRIP_STARTED" ? <Button title="Complete trip" kind="amber" loading={busy === "complete"} onPress={complete} /> : null}

          {r.status !== "TRIP_STARTED" ? (
            confirmCancel ? (
              <Card style={{ borderColor: colors.red, backgroundColor: "#fff" }}>
                <Txt variant="label" color={colors.ink}>Cancel this trip?</Txt>
                <Muted style={{ color: colors.muted }}>Cancellations lower your acceptance score. If the passenger hasn't shown up, we'll record a no-show.</Muted>
                <Row>
                  <Button title="Keep trip" kind="secondary" style={{ flex: 1 }} onPress={() => setConfirmCancel(false)} />
                  <Button title="Cancel" style={{ flex: 1, backgroundColor: colors.red, borderColor: colors.red }} loading={busy === "cancel"} onPress={cancel} />
                </Row>
              </Card>
            ) : (
              <Button title="Cancel trip" kind="danger" onPress={() => setConfirmCancel(true)} />
            )
          ) : null}
          <Muted center style={{ color: colors.muted }}>{km(r.distanceM)} trip · fare locked at {naira(r.agreedFare)}</Muted>
        </ScrollView>
      </SafeAreaView>
      </ThemeContext.Provider>
    </View>
  );
}

function TripSummary({ ride, onDone }: { ride: RideView; onDone: () => void }) {
  const [stars, setStars] = useState(ride.myRating ?? 0);
  const [sent, setSent] = useState(ride.myRating !== null);
  const done = ride.status === "TRIP_COMPLETED";
  const fare = BigInt(ride.agreedFare);
  const collect = BigInt(ride.passengerPays);
  const discount = BigInt(ride.discountAmount);
  const commission = BigInt(ride.commissionAmount ?? "0");

  const rate = async (n: number) => {
    setStars(n);
    await api.post(`/v1/rides/${ride.id}/ratings`, { stars: n }).catch(() => undefined);
    setSent(true);
  };

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", gap: space.lg }}>
        <Pill label={done ? "Trip completed" : "Trip cancelled"} tone={done ? "green" : "red"} />
        {done ? (
          <>
            <Txt variant="display">{ride.paymentMethod === "CASH" ? `Collect ${naira(collect)}` : naira(fare)}</Txt>
            <Card>
              <Row style={{ justifyContent: "space-between" }}><Muted>Fare</Muted><Txt variant="label">{naira(fare)}</Txt></Row>
              {discount > 0n ? <Row style={{ justifyContent: "space-between" }}><Muted>Promo paid by Riders App</Muted><Txt variant="label">{naira(discount)}</Txt></Row> : null}
              <Row style={{ justifyContent: "space-between" }}><Muted>Riders App commission</Muted><Txt variant="label">−{naira(commission)}</Txt></Row>
              <Row style={{ justifyContent: "space-between" }}><Txt variant="label">You earn</Txt><Txt variant="heading">{naira(fare - commission)}</Txt></Row>
              <Muted>{ride.paymentMethod === "CASH" ? `The passenger pays you ${naira(collect)} in cash. The commission${discount > 0n ? " and the promo top-up are" : " is"} settled in your Riders App wallet.` : `${ride.paymentMethod === "CARD" ? "Paid by card. " : ""}Earnings arrive in your wallet after the 24-hour hold.`}</Muted>
            </Card>
            <Card>
              <Txt variant="label">Rate {ride.passenger.firstName}</Txt>
              <Row gap={space.sm}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <Pressable key={n} accessibilityRole="button" accessibilityLabel={`${n} star${n > 1 ? "s" : ""}`} disabled={sent} onPress={() => rate(n)} style={{ padding: 4 }}>
                    <Txt variant="display" color={n <= stars ? colors.amber : colors.nightMuted}>★</Txt>
                  </Pressable>
                ))}
              </Row>
            </Card>
          </>
        ) : (
          <Muted variant="body">This trip was cancelled. You're available for new requests.</Muted>
        )}
        <Button title="Back to requests" onPress={onDone} />
        <Button title="Report a problem with this trip" kind="ghost" onPress={() => router.push({ pathname: "/(app)/report", params: { rideId: ride.id } })} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "60%", backgroundColor: "#fff", borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.xl, elevation: 8 },
});
