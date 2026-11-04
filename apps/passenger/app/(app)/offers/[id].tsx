import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OfferView, RideRequestView } from "@zuma/contracts";
import { api, Banner, Button, Card, clock, colors, errorMessage, Loading, minutes, Muted, naira, Row, Screen, secondsLeft, space, Txt, useRealtimeConnected, useServerEvent } from "@zuma/mobile-core";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, View } from "react-native";

export default function Offers() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const connected = useRealtimeConnected();
  const [now, setNow] = useState(Date.now());
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const req = useQuery({
    queryKey: ["request", id],
    queryFn: () => api.get<RideRequestView>(`/v1/ride-requests/${id}`),
    // Sockets push offers; polling is the fallback when the socket is down.
    refetchInterval: connected ? 15_000 : 4_000,
  });

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useServerEvent<{ requestId: string; offer: OfferView }>("offer.upserted", (e) => {
    if (e.requestId !== id) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    qc.setQueryData<RideRequestView>(["request", id], (old) => {
      if (!old) return old;
      const others = old.offers.filter((o) => o.id !== e.offer.id);
      return { ...old, status: "OFFERS_RECEIVED", offers: [...others, e.offer].sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1)) };
    });
  });
  useServerEvent<{ requestId: string; offerId: string }>("offer.withdrawn", (e) => {
    if (e.requestId === id) qc.setQueryData<RideRequestView>(["request", id], (old) => (old ? { ...old, offers: old.offers.filter((o) => o.id !== e.offerId) } : old));
  });
  useServerEvent<{ requestId: string; status: string; rideId?: string }>("ride_request.status", (e) => {
    if (e.requestId === id) qc.invalidateQueries({ queryKey: ["request", id] });
  });

  if (req.isLoading) return <Screen><Loading label="Loading your request…" /></Screen>;
  if (req.isError || !req.data) return <Screen><Banner text={errorMessage(req.error)} /></Screen>;
  const r = req.data;
  if (r.rideId) return <Redirect href={{ pathname: "/(app)/trip/[id]", params: { id: r.rideId } }} />;

  const left = secondsLeft(r.expiresAt);
  void now;
  const closed = ["EXPIRED", "CANCELLED"].includes(r.status) || left === 0;
  const liveOffers = r.offers.filter((o) => o.status === "PENDING" && secondsLeft(o.expiresAt) > 0);
  const raiseTo = BigInt(r.proposedFare) + 50000n;
  const canRaise = raiseTo <= BigInt(r.maxFare);

  const accept = async (o: OfferView) => {
    setActing(o.id);
    setError(null);
    try {
      const res = await api.post<{ rideId: string }>(`/v1/ride-requests/${id}/offers/${o.id}/accept`, {}, Crypto.randomUUID());
      router.replace({ pathname: "/(app)/trip/[id]", params: { id: res.rideId } });
    } catch (e) {
      setError(errorMessage(e));
      qc.invalidateQueries({ queryKey: ["request", id] });
    } finally {
      setActing(null);
    }
  };

  const reject = async (o: OfferView) => {
    await api.post(`/v1/ride-requests/${id}/offers/${o.id}/reject`).catch(() => undefined);
    qc.invalidateQueries({ queryKey: ["request", id] });
  };

  const raise = async () => {
    setError(null);
    try {
      await api.patch(`/v1/ride-requests/${id}/fare`, { proposedFare: raiseTo.toString() });
      qc.invalidateQueries({ queryKey: ["request", id] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const cancel = async () => {
    await api.post(`/v1/ride-requests/${id}/cancel`, { reasonCode: "CHANGED_PLANS" }).catch(() => undefined);
    qc.invalidateQueries({ queryKey: ["current"] });
    router.replace("/(app)/home");
  };

  if (closed) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: "center", gap: space.lg }}>
          <Txt variant="title">{r.status === "CANCELLED" ? "Request cancelled" : "No driver accepted in time"}</Txt>
          <Muted variant="body">{r.status === "CANCELLED" ? "You can book again whenever you're ready." : `Try again, or offer a little more than ${naira(r.proposedFare)} to reach more drivers.`}</Muted>
          <Button title="Book again" onPress={() => { qc.invalidateQueries({ queryKey: ["current"] }); router.replace("/(app)/fare"); }} />
          <Button title="Back to map" kind="secondary" onPress={() => { qc.invalidateQueries({ queryKey: ["current"] }); router.replace("/(app)/home"); }} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ flex: 1, gap: space.md, paddingTop: space.md }}>
        <View style={{ alignItems: "center", gap: 2 }}>
          <Txt variant="title">{liveOffers.length ? `${liveOffers.length} driver${liveOffers.length > 1 ? "s" : ""} responded` : "Finding drivers…"}</Txt>
          <Muted>Request open for {clock(left)} more</Muted>
        </View>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: "hidden" }}>
          <View style={{ height: 4, width: `${Math.min(100, (left / 180) * 100)}%`, backgroundColor: colors.amber }} />
        </View>
        {!connected ? <Banner tone="amber" text="Reconnecting… offers may arrive a few seconds late." /> : null}

        <Card style={{ padding: space.md }}>
          <Row style={{ justifyContent: "space-between" }}>
            <View style={{ flex: 1 }}>
              <Muted>Your offer · {r.categoryKey} · {r.paymentMethod.toLowerCase()}</Muted>
              <Txt variant="label" numberOfLines={1}>{r.pickup.address.split(",")[0]} → {r.dropoff.address.split(",")[0]}</Txt>
            </View>
            <Txt variant="title">{naira(r.proposedFare)}</Txt>
          </Row>
        </Card>

        {error ? <Banner text={error} /> : null}

        <FlatList
          data={liveOffers}
          keyExtractor={(o) => o.id}
          contentContainerStyle={{ gap: space.sm }}
          ListEmptyComponent={<Muted center>Drivers nearby are seeing your request. Offers appear here as they come in.</Muted>}
          renderItem={({ item: o }) => {
            const diff = BigInt(o.amount) - BigInt(r.proposedFare);
            return (
              <Card>
                <Row>
                  <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.map, alignItems: "center", justifyContent: "center" }}>
                    <Txt variant="heading">{o.driver.firstName.slice(0, 2).toUpperCase()}</Txt>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Txt variant="heading">{o.driver.firstName}</Txt>
                    <Muted>★ {o.driver.ratingAvg} · {o.driver.tripsCompleted} trips</Muted>
                    <Muted>{o.vehicle.colour} {o.vehicle.make} {o.vehicle.model}{o.etaToPickupS ? ` · ${minutes(o.etaToPickupS)} away` : ""}</Muted>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Txt variant="title">{naira(o.amount)}</Txt>
                    <Txt variant="small" color={diff === 0n ? colors.green : colors.amberText}>{diff === 0n ? "Your price" : `+${naira(diff)}`}</Txt>
                  </View>
                </Row>
                <Row>
                  <Button title="Decline" kind="secondary" style={{ flex: 1 }} onPress={() => reject(o)} />
                  <Button title={`Accept ${naira(o.amount)}`} style={{ flex: 2 }} loading={acting === o.id} disabled={!!acting} onPress={() => accept(o)} />
                </Row>
              </Card>
            );
          }}
        />

        {canRaise ? <Button title={`Raise my offer to ${naira(raiseTo)}`} kind="secondary" onPress={raise} /> : null}
        <Button title="Cancel request" kind="ghost" onPress={cancel} />
      </View>
    </Screen>
  );
}
