import { api, Banner, Button, Card, colors, errorMessage, Loading, Muted, Screen, space, Txt } from "@zuma/mobile-core";
import * as Location from "expo-location";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, View } from "react-native";

interface SosResult {
  incidentId: string;
  opsAlerted: boolean;
  emergencyServicesContacted: boolean;
  emergencyNumbers: string[];
  contactsNotified?: number;
}

/**
 * SOS: alerts the Zuma safety team with the rider's location and offers direct calls to emergency numbers.
 * It says emergency services were contacted only when the server reports that an operator recorded it.
 */
export default function Sos() {
  const { rideId } = useLocalSearchParams<{ rideId?: string }>();
  const [state, setState] = useState<"sending" | "sent" | "failed">("sending");
  const [result, setResult] = useState<SosResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setState("sending");
    setError(null);
    try {
      let pos = { lat: 0, lng: 0 };
      try {
        const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        pos = { lat: p.coords.latitude, lng: p.coords.longitude };
      } catch {
        const last = await Location.getLastKnownPositionAsync();
        if (last) pos = { lat: last.coords.latitude, lng: last.coords.longitude };
      }
      const r = await api.post<SosResult>("/v1/safety/sos", { rideId: rideId || undefined, ...pos });
      setResult(r);
      setState("sent");
    } catch (e) {
      setError(errorMessage(e));
      setState("failed");
    }
  };

  useEffect(() => {
    send();
  }, []);

  const numbers = result?.emergencyNumbers ?? ["112", "199"];
  const call = (n: string) => Linking.openURL(`tel:${n}`).catch(() => undefined);

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", gap: space.lg }}>
        <Txt variant="display" color={colors.red}>Emergency</Txt>
        {state === "sending" ? <Loading label="Alerting the Zuma safety team…" /> : null}
        {state === "sent" ? (
          <Banner tone="green" text={result?.emergencyServicesContacted ? "The Zuma safety team has contacted emergency services and is following your trip." : "The Zuma safety team has your location and will call you shortly. Zuma has not contacted the police or an ambulance. Call them now if you are in danger."} />
        ) : null}
        {state === "sent" && result?.contactsNotified ? <Muted variant="body">We texted your location to {result.contactsNotified} emergency contact{result.contactsNotified > 1 ? "s" : ""}.</Muted> : null}
        {state === "sent" && result && !result.contactsNotified ? <Button title="Add emergency contacts for next time" kind="ghost" onPress={() => router.push("/(app)/contacts")} /> : null}
        {state === "failed" ? (
          <>
            <Banner text={`We couldn't reach Zuma: ${error}. Call emergency services directly.`} />
            <Button title="Try alerting Zuma again" kind="secondary" onPress={send} />
          </>
        ) : null}
        <Card style={{ gap: space.md }}>
          <Muted variant="body">If you are in danger, call now:</Muted>
          {numbers.map((n, i) => (
            <Button key={n} title={`Call ${n}${n === "112" ? " (emergency)" : n === "199" ? " (police)" : ""}`} kind={i === 0 ? "primary" : "secondary"} style={i === 0 ? { backgroundColor: colors.red, borderColor: colors.red } : undefined} onPress={() => call(n)} />
          ))}
        </Card>
        <Button title="Back to trip" kind="ghost" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}
