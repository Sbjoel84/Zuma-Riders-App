import { useQuery } from "@tanstack/react-query";
import type { RideRequestView, RideView, WalletView } from "@zuma/contracts";
import { api, Banner, colors, naira, radius, Row, space, Txt, Muted, useSession } from "@zuma/mobile-core";
import * as Location from "expo-location";
import { Redirect, router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import MapView, { Marker } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { ABUJA_CENTER, useBooking } from "../../src/booking";

export default function Home() {
  const me = useSession((s) => s.me);
  const signOut = useSession((s) => s.signOut);
  const { pickup, setPickup, setEditing } = useBooking();
  const [permission, setPermission] = useState<"unknown" | "granted" | "denied">("unknown");
  const map = useRef<MapView>(null);

  const current = useQuery({ queryKey: ["current"], queryFn: () => api.get<{ ride: RideView | null; request: RideRequestView | null }>("/v1/rides/current") });
  const wallet = useQuery({ queryKey: ["wallet"], queryFn: () => api.get<WalletView>("/v1/wallet") });
  const nearby = useQuery({
    queryKey: ["nearby", pickup?.lat, pickup?.lng],
    enabled: !!pickup,
    refetchInterval: 15_000,
    queryFn: () => api.get<{ inServiceArea: boolean; drivers: { lat: number; lng: number }[] }>(`/v1/maps/nearby-drivers?lat=${pickup!.lat}&lng=${pickup!.lng}`),
  });

  // Locate the passenger and set pickup to the current position.
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return setPermission("denied");
      setPermission("granted");
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      map.current?.animateToRegion({ latitude: coords.lat, longitude: coords.lng, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 400);
      if (!useBooking.getState().pickup) {
        const r = await api.get<{ address: string }>(`/v1/maps/reverse-geocode?lat=${coords.lat}&lng=${coords.lng}`).catch(() => ({ address: "Current location" }));
        setPickup({ ...coords, address: r.address });
      }
    })();
  }, [setPickup]);

  // Resume an in-progress booking after an app restart.
  if (current.data?.ride) return <Redirect href={{ pathname: "/(app)/trip/[id]", params: { id: current.data.ride.id } }} />;
  if (current.data?.request) return <Redirect href={{ pathname: "/(app)/offers/[id]", params: { id: current.data.request.id } }} />;

  return (
    <View style={{ flex: 1 }}>
      <MapView ref={map} style={StyleSheet.absoluteFill} initialRegion={ABUJA_CENTER} showsUserLocation={permission === "granted"} showsMyLocationButton={false} toolbarEnabled={false}>
        {pickup ? <Marker coordinate={{ latitude: pickup.lat, longitude: pickup.lng }} pinColor={colors.ink} title="Pickup" /> : null}
        {nearby.data?.drivers.map((d, i) => (
          <Marker key={i} coordinate={{ latitude: d.lat, longitude: d.lng }} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
            <View style={styles.car} />
          </Marker>
        ))}
      </MapView>

      <SafeAreaView edges={["top"]} style={styles.top}>
        <Row style={{ justifyContent: "space-between" }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={signOut} style={styles.roundBtn}>
            <Txt variant="label">{(me?.firstName?.[0] ?? "Z").toUpperCase()}</Txt>
          </Pressable>
          <View style={styles.brand}><Txt variant="heading" color="#fff">zuma</Txt></View>
          <View style={[styles.roundBtn, { width: undefined, paddingHorizontal: 14 }]} accessibilityLabel={`Wallet balance ${naira(wallet.data?.availableBalance)}`}>
            <Txt variant="label">{wallet.data ? naira(wallet.data.availableBalance) : "₦—"}</Txt>
          </View>
        </Row>
      </SafeAreaView>

      <SafeAreaView edges={["bottom"]} style={styles.sheet}>
        <View style={styles.handle} />
        <Txt variant="title">Where to, {me?.firstName || "there"}?</Txt>
        {permission === "denied" ? <Banner tone="amber" text="Location is off. Set your pickup by searching for it." /> : null}
        {nearby.data && !nearby.data.inServiceArea ? <Banner tone="amber" text="You're outside our service area. Zuma is live in Abuja." /> : null}

        <Pressable accessibilityRole="button" onPress={() => { setEditing("pickup"); router.push("/(app)/search"); }} style={styles.field}>
          <View style={styles.dotPickup} />
          <View style={{ flex: 1 }}>
            <Muted>Pickup</Muted>
            <Txt variant="label" numberOfLines={1}>{pickup?.address ?? (permission === "unknown" ? "Finding your location…" : "Set pickup")}</Txt>
          </View>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => { setEditing("dropoff"); router.push("/(app)/search"); }} style={[styles.field, styles.fieldStrong]}>
          <View style={styles.dotDrop} />
          <Txt variant="heading">Where are you going?</Txt>
        </Pressable>
        <Muted>{nearby.data?.drivers.length ? `${nearby.data.drivers.length} drivers nearby` : " "}</Muted>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { position: "absolute", left: space.lg, right: space.lg, top: 0, paddingTop: space.sm },
  roundBtn: { height: 44, width: 44, borderRadius: 22, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 8, elevation: 3 },
  brand: { backgroundColor: colors.ink, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 22 },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: "#fff", borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.xl, paddingTop: space.md, gap: space.md, elevation: 8, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 24 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: "#d6d9d2", alignSelf: "center" },
  field: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: colors.ground, minHeight: 56 },
  fieldStrong: { backgroundColor: colors.ground, borderWidth: 2, borderColor: colors.ink },
  dotPickup: { width: 12, height: 12, borderRadius: 6, borderWidth: 3, borderColor: colors.ink },
  dotDrop: { width: 12, height: 12, borderRadius: 2, backgroundColor: colors.amber, borderWidth: 2, borderColor: colors.ink },
  car: { width: 16, height: 10, borderRadius: 3, backgroundColor: colors.ink },
});
