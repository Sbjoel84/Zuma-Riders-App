import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RideView } from "@zuma/contracts";
import { api, Banner, Button, Card, colors, errorMessage, km, Loading, Muted, naira, Pill, radius, Row, Screen, space, Txt, useRealtimeConnected, useServerEvent } from "@zuma/mobile-core";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Share, StyleSheet, View } from "react-native";
import MapView, { Marker } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { useBooking } from "../../../src/booking";

const STATUS_COPY: Record<string, { title: string; tone: "amber" | "blue" | "green" | "red" | "neutral" }> = {
  DRIVER_SELECTED: { title: "Driver confirmed", tone: "amber" },
  DRIVER_EN_ROUTE: { title: "Driver is on the way", tone: "amber" },
  DRIVER_ARRIVED: { title: "Your driver has arrived", tone: "green" },
  TRIP_STARTED: { title: "On your way", tone: "blue" },
  TRIP_COMPLETED: { title: "You've arrived", tone: "green" },
  CANCELLED: { title: "Trip cancelled", tone: "red" },
  DISPUTED: { title: "Under review", tone: "neutral" },
};

export default function Trip() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const connected = useRealtimeConnected();
  const resetBooking = useBooking((s) => s.reset);
  const [driverPos, setDriverPos] = useState<{ lat: number; lng: number } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState<string | null>(null);
  const map = useRef<MapView>(null);

  const ride = useQuery({
    queryKey: ["ride", id],
    queryFn: () => api.get<RideView>(`/v1/rides/${id}`),
    refetchInterval: connected ? 20_000 : 5_000,
  });

  useEffect(() => {
    if (ride.data?.driver.lat && ride.data.driver.lng && !driverPos) setDriverPos({ lat: ride.data.driver.lat, lng: ride.data.driver.lng });
  }, [ride.data, driverPos]);

  useServerEvent<{ rideId: string; lat: number; lng: number }>("ride.driver_location", (e) => {
    if (e.rideId === id) setDriverPos({ lat: e.lat, lng: e.lng });
  });
  useServerEvent<{ rideId: string; status: string }>("ride.status", (e) => {
    if (e.rideId === id) qc.invalidateQueries({ queryKey: ["ride", id] });
  });
  useServerEvent<{ rideId: string; message: { fromMe: boolean } }>("chat.message", (e) => {
    if (e.rideId === id && !e.message.fromMe) qc.invalidateQueries({ queryKey: ["ride", id] });
  });

  useEffect(() => {
    const r = ride.data;
    if (!r) return;
    const points = [{ latitude: r.pickup.lat, longitude: r.pickup.lng }, { latitude: r.dropoff.lat, longitude: r.dropoff.lng }];
    if (driverPos) points.push({ latitude: driverPos.lat, longitude: driverPos.lng });
    map.current?.fitToCoordinates(points, { edgePadding: { top: 120, right: 60, bottom: 460, left: 60 }, animated: true });
  }, [ride.data?.status, !!driverPos]);

  if (ride.isLoading) return <Screen><Loading label="Loading your trip…" /></Screen>;
  if (ride.isError || !ride.data) return <Screen><Banner text={errorMessage(ride.error)} /></Screen>;
  const r = ride.data;
  const copy = STATUS_COPY[r.status] ?? { title: r.status, tone: "neutral" as const };

  if (r.status === "TRIP_COMPLETED" || r.status === "CANCELLED") {
    return <TripEnded ride={r} onDone={() => { resetBooking(); qc.invalidateQueries({ queryKey: ["current"] }); qc.invalidateQueries({ queryKey: ["wallet"] }); router.replace("/(app)/home"); }} />;
  }

  const shareTrip = async () => {
    setError(null);
    try {
      const r = await api.post<{ url: string; contactsNotified: number }>(`/v1/rides/${id}/share`, { notifyContacts: true });
      setShared(r.contactsNotified ? `Texted a live link to ${r.contactsNotified} emergency contact${r.contactsNotified > 1 ? "s" : ""}.` : "Link ready.");
      await Share.share({ message: `Follow my Zuma trip live: ${r.url}` });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const cancel = async () => {
    setError(null);
    try {
      await api.post(`/v1/rides/${id}/cancel`, { reasonCode: "CHANGED_PLANS" });
      setConfirmCancel(false);
      qc.invalidateQueries({ queryKey: ["ride", id] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.map }}>
      <MapView ref={map} style={StyleSheet.absoluteFill} initialRegion={{ latitude: r.pickup.lat, longitude: r.pickup.lng, latitudeDelta: 0.04, longitudeDelta: 0.04 }} toolbarEnabled={false}>
        <Marker coordinate={{ latitude: r.pickup.lat, longitude: r.pickup.lng }} title="Pickup" pinColor={colors.ink} />
        <Marker coordinate={{ latitude: r.dropoff.lat, longitude: r.dropoff.lng }} title="Destination" pinColor={colors.amber} />
        {driverPos ? (
          <Marker coordinate={{ latitude: driverPos.lat, longitude: driverPos.lng }} anchor={{ x: 0.5, y: 0.5 }} title={`${r.driver.firstName} · ${r.vehicle.plateNumber}`}>
            <View style={styles.car} />
          </Marker>
        ) : null}
      </MapView>

      <SafeAreaView edges={["top"]} style={styles.top}>
        <Row style={{ justifyContent: "space-between" }}>
          <View style={styles.statusPill}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.amber }} />
            <Txt variant="label" color="#fff">{copy.title}</Txt>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Emergency SOS" onPress={() => router.push({ pathname: "/(app)/sos", params: { rideId: id } })} style={styles.sos}>
            <Txt variant="label" color="#fff">SOS</Txt>
          </Pressable>
        </Row>
        {!connected ? <View style={{ marginTop: space.sm }}><Banner tone="amber" text="Reconnecting… driver position may lag." /></View> : null}
      </SafeAreaView>

      <SafeAreaView edges={["bottom"]} style={styles.sheet}>
        <ScrollView contentContainerStyle={{ gap: space.lg }}>
          <View style={styles.handle} />
          <Row>
            <View style={styles.avatar}><Txt variant="heading">{r.driver.firstName.slice(0, 2).toUpperCase()}</Txt></View>
            <View style={{ flex: 1 }}>
              <Txt variant="heading">{r.driver.firstName}</Txt>
              <Muted>★ {r.driver.ratingAvg} · {r.driver.tripsCompleted} trips</Muted>
            </View>
            <View style={{ alignItems: "flex-end", gap: 4 }}>
              <View style={styles.plate}><Txt variant="heading" style={{ letterSpacing: 1 }}>{r.vehicle.plateNumber}</Txt></View>
              <Muted>{r.vehicle.colour} {r.vehicle.make} {r.vehicle.model}</Muted>
            </View>
          </Row>

          {r.tripPin ? (
            <View style={styles.pinBox}>
              <View style={{ flex: 1 }}>
                <Txt variant="label">Trip PIN</Txt>
                <Muted>Tell the driver this PIN when you get in. Don't share it before.</Muted>
              </View>
              <Row gap={6}>
                {r.tripPin.split("").map((d, i) => (
                  <View key={i} style={styles.pinDigit}><Txt variant="title">{d}</Txt></View>
                ))}
              </Row>
            </View>
          ) : null}

          {r.status === "DRIVER_ARRIVED" ? <Banner tone="green" text={`${r.driver.firstName} is waiting at the pickup point.`} /> : null}

          <Row gap={space.sm}>
            <Button title={r.unreadMessages ? `Message · ${r.unreadMessages} new` : `Message ${r.driver.firstName}`} kind={r.unreadMessages ? "amber" : "secondary"} style={{ flex: 1 }} onPress={() => router.push({ pathname: "/(app)/chat/[id]", params: { id } })} />
            <Button title="Share trip" kind="secondary" style={{ flex: 1 }} onPress={shareTrip} />
          </Row>
          {shared ? <Muted>{shared}</Muted> : null}

          <Card style={{ padding: space.md }}>
            <Row style={{ justifyContent: "space-between" }}>
              <View style={{ flex: 1 }}>
                <Muted>{BigInt(r.discountAmount) > 0n ? "You pay" : "Agreed fare"} · {r.paymentMethod === "CASH" ? "pay the driver in cash" : r.paymentMethod === "CARD" ? "card charged at the end" : "paid from wallet"}</Muted>
                <Txt variant="label" numberOfLines={1}>{r.dropoff.address}</Txt>
              </View>
              <Txt variant="title">{naira(r.passengerPays)}</Txt>
            </Row>
            {BigInt(r.discountAmount) > 0n ? <Muted>{naira(r.agreedFare)} fare − {naira(r.discountAmount)} promo, paid by Zuma</Muted> : null}
            <Muted>{km(r.distanceM)} trip · fare locked when you accepted</Muted>
          </Card>

          {error ? <Banner text={error} /> : null}

          {r.status !== "TRIP_STARTED" ? (
            confirmCancel ? (
              <Card style={{ borderColor: colors.red }}>
                <Txt variant="label">Cancel this trip?</Txt>
                <Muted>Cancelling more than 2 minutes after the driver accepted may add a cancellation fee to your next trip.</Muted>
                <Row>
                  <Button title="Keep trip" kind="secondary" style={{ flex: 1 }} onPress={() => setConfirmCancel(false)} />
                  <Button title="Cancel trip" kind="primary" style={{ flex: 1, backgroundColor: colors.red, borderColor: colors.red }} onPress={cancel} />
                </Row>
              </Card>
            ) : (
              <Button title="Cancel trip" kind="danger" onPress={() => setConfirmCancel(true)} />
            )
          ) : (
            <Muted center>Share your trip or use SOS if you feel unsafe.</Muted>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function TripEnded({ ride, onDone }: { ride: RideView; onDone: () => void }) {
  const [stars, setStars] = useState(ride.myRating ?? 0);
  const [sent, setSent] = useState(ride.myRating !== null);
  const [busy, setBusy] = useState(false);
  const completed = ride.status === "TRIP_COMPLETED";

  const rate = async (n: number) => {
    setStars(n);
    setBusy(true);
    try {
      await api.post(`/v1/rides/${ride.id}/ratings`, { stars: n });
      setSent(true);
    } catch {
      setSent(true); // already rated
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", gap: space.xl }}>
        <Pill label={completed ? "Trip completed" : "Trip cancelled"} tone={completed ? "green" : "red"} />
        <Txt variant="display">{completed ? naira(ride.finalFare ?? ride.agreedFare) : "Cancelled"}</Txt>
        <Muted variant="body">
          {completed
            ? ride.paymentMethod === "CASH"
              ? `Pay ${ride.driver.firstName} ${naira(ride.passengerPays)} in cash.`
              : ride.paymentMethod === "CARD"
                ? `Charged to your card${ride.card?.last4 ? ` ••${ride.card.last4}` : ""}.`
                : "Paid from your wallet."
            : "No charge was made for this trip."}
          {completed && BigInt(ride.discountAmount) > 0n ? ` You saved ${naira(ride.discountAmount)} with a promo.` : ""}
        </Muted>
        {completed ? (
          <Card>
            <Txt variant="label">How was your ride with {ride.driver.firstName}?</Txt>
            <Row gap={space.sm}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Pressable key={n} accessibilityRole="button" accessibilityLabel={`${n} star${n > 1 ? "s" : ""}`} disabled={sent || busy} onPress={() => rate(n)} style={{ padding: 4 }}>
                  <Txt variant="display" color={n <= stars ? colors.amber : colors.line}>★</Txt>
                </Pressable>
              ))}
            </Row>
            {sent ? <Muted>Thanks for rating.</Muted> : null}
          </Card>
        ) : null}
        <Button title="Done" onPress={onDone} />
        <Button title="Report a problem with this trip" kind="ghost" onPress={() => router.push({ pathname: "/(app)/report", params: { rideId: ride.id } })} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { position: "absolute", top: 0, left: space.lg, right: space.lg, paddingTop: space.sm },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.ink, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 22 },
  sos: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.red, alignItems: "center", justifyContent: "center" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "62%", backgroundColor: "#fff", borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.xl, paddingTop: space.md, elevation: 8 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: "#d6d9d2", alignSelf: "center" },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.map, alignItems: "center", justifyContent: "center" },
  plate: { borderWidth: 2, borderColor: colors.ink, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  pinBox: { flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: colors.amberSoft, borderRadius: radius.lg, padding: space.lg },
  pinDigit: { width: 36, height: 44, borderRadius: 8, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  car: { width: 20, height: 12, borderRadius: 3, backgroundColor: colors.amber, borderWidth: 2, borderColor: colors.ink },
});
