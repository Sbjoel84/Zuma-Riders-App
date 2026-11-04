import type { EstimateResponse, PaymentMethodType, RideRequestView, WalletView } from "@zuma/contracts";
import { ApiRequestError, api, Banner, Button, Chip, colors, errorMessage, km, Loading, minutes, Muted, naira, Row, Screen, space, Stepper, Txt } from "@zuma/mobile-core";
import { useQuery } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useBooking } from "../../src/booking";

const STEP = 10000n; // ₦100

export default function Fare() {
  const { pickup, dropoff, setEstimate } = useBooking();
  const [category, setCategory] = useState<string>("economy");
  const [fare, setFare] = useState<bigint | null>(null);
  const [payment, setPayment] = useState<PaymentMethodType>("CASH");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per booking attempt: a retry after a network drop can't create a second request.
  const idemKey = useRef(Crypto.randomUUID());

  const estimate = useQuery({
    queryKey: ["estimate", pickup, dropoff],
    enabled: !!pickup && !!dropoff,
    queryFn: () => api.post<EstimateResponse>("/v1/ride-requests/estimate", { pickup, dropoff }),
  });
  const wallet = useQuery({ queryKey: ["wallet"], queryFn: () => api.get<WalletView>("/v1/wallet") });

  useEffect(() => {
    if (estimate.data) setEstimate(estimate.data);
  }, [estimate.data, setEstimate]);

  const cat = useMemo(() => estimate.data?.categories.find((c) => c.categoryKey === category) ?? estimate.data?.categories[0], [estimate.data, category]);
  useEffect(() => {
    if (cat) setFare(BigInt(cat.suggestedFare));
  }, [cat?.categoryKey, cat?.suggestedFare]);

  if (!pickup || !dropoff) {
    router.replace("/(app)/home");
    return null;
  }
  if (estimate.isLoading) return <Screen><Loading label="Calculating route and fares…" /></Screen>;
  if (estimate.isError || !estimate.data || !cat || fare === null) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: "center", gap: space.lg }}>
          <Banner text={estimate.error ? errorMessage(estimate.error) : "No vehicles are available for this trip."} />
          <Button title="Change destination" onPress={() => router.replace("/(app)/search")} />
        </View>
      </Screen>
    );
  }

  const min = BigInt(cat.minFare);
  const max = BigInt(cat.maxFare);
  const suggested = BigInt(cat.suggestedFare);
  const walletShort = payment === "WALLET" && wallet.data && BigInt(wallet.data.availableBalance) < fare;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<RideRequestView>("/v1/ride-requests", { pickup, dropoff, categoryKey: cat.categoryKey, proposedFare: fare.toString(), paymentMethod: payment }, idemKey.current);
      router.replace({ pathname: "/(app)/offers/[id]", params: { id: r.id } });
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "ACTIVE_REQUEST_EXISTS") {
        const d = e.details as { requestId?: string; rideId?: string } | undefined;
        if (d?.rideId) return router.replace({ pathname: "/(app)/trip/[id]", params: { id: d.rideId } });
        if (d?.requestId) return router.replace({ pathname: "/(app)/offers/[id]", params: { id: d.requestId } });
      }
      setError(errorMessage(e));
      idemKey.current = Crypto.randomUUID();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}>
        <Row>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={{ padding: space.sm }}>
            <Txt variant="title">‹</Txt>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Txt variant="label" numberOfLines={1}>{pickup.address}</Txt>
            <Muted numberOfLines={1}>to {dropoff.address}</Muted>
          </View>
          <Muted>{km(estimate.data.distanceM)} · {minutes(estimate.data.durationS)}</Muted>
        </Row>

        <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: space.sm }}>
          {estimate.data.categories.map((c) => (
            <Chip key={c.categoryKey} label={c.name} sub={`${c.seats} seats`} selected={c.categoryKey === cat.categoryKey} onPress={() => setCategory(c.categoryKey)} />
          ))}
        </View>

        <View style={{ gap: space.sm }}>
          <Row style={{ justifyContent: "space-between" }}>
            <Txt variant="label">Offer your fare</Txt>
            <Muted>Suggested {naira(suggested)}</Muted>
          </Row>
          <Stepper
            value={naira(fare)}
            decLabel="Lower fare by ₦100"
            incLabel="Raise fare by ₦100"
            onDec={() => setFare((f) => (f! - STEP < min ? min : f! - STEP))}
            onInc={() => setFare((f) => (f! + STEP > max ? max : f! + STEP))}
          />
          {fare <= min ? <Txt variant="small" color={colors.red}>Minimum fare for this trip is {naira(min)}.</Txt> : fare < suggested ? <Txt variant="small" color={colors.amberText}>Below the suggested fare. Fewer drivers may respond.</Txt> : <Muted> </Muted>}
        </View>

        <View style={{ gap: space.sm }}>
          <Txt variant="label">Payment</Txt>
          <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: space.sm }}>
            <Chip label="Cash" selected={payment === "CASH"} onPress={() => setPayment("CASH")} />
            <Chip label="Wallet" sub={wallet.data ? naira(wallet.data.availableBalance) : undefined} selected={payment === "WALLET"} onPress={() => setPayment("WALLET")} />
          </View>
          {walletShort ? <Banner tone="amber" text="Your wallet balance is lower than this fare. Pay with cash or top up." /> : null}
        </View>

        {error ? <Banner text={error} /> : null}
        <Button title={`Find drivers for ${naira(fare)}`} onPress={submit} loading={busy} disabled={!!walletShort} />
      </ScrollView>
    </Screen>
  );
}
