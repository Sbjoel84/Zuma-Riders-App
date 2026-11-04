import { Banner, Button, Card, colors, Muted, Screen, space, Txt } from "@zuma/mobile-core";
import { router } from "expo-router";
import { Linking, View } from "react-native";

/**
 * SOS screen. In this slice it only offers direct calls to emergency numbers.
 * It never claims anyone has been notified: emergency-contact SMS and the ops alert
 * arrive with the safety module, and the copy will change only when those are real.
 */
export default function Sos() {
  const call = (n: string) => Linking.openURL(`tel:${n}`).catch(() => undefined);
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", gap: space.lg }}>
        <Txt variant="display" color={colors.red}>Emergency</Txt>
        <Muted variant="body">If you are in danger, call emergency services now. Zuma has not contacted anyone on your behalf.</Muted>
        <Card style={{ gap: space.md }}>
          <Button title="Call 112 (emergency)" onPress={() => call("112")} style={{ backgroundColor: colors.red, borderColor: colors.red }} />
          <Button title="Call 199 (police)" kind="secondary" onPress={() => call("199")} />
        </Card>
        <Banner tone="amber" text="Alerts to your emergency contacts and the Zuma safety team are coming in the next update." />
        <Button title="Back to trip" kind="ghost" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}
