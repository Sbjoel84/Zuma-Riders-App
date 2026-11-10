import { useQuery } from "@tanstack/react-query";
import { api, Card, colors, Divider, Muted, naira, Row, Screen, space, Txt, useSession } from "@zuma/mobile-core";
import type { WalletView } from "@zuma/contracts";
import { router } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";

function Item({ label, sub, onPress, danger }: { label: string; sub?: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ paddingVertical: space.md, opacity: pressed ? 0.6 : 1 })}>
      <Row style={{ justifyContent: "space-between" }}>
        <View style={{ flex: 1 }}>
          <Txt variant="heading" color={danger ? colors.red : undefined}>{label}</Txt>
          {sub ? <Muted>{sub}</Muted> : null}
        </View>
        {!danger ? <Txt variant="title" color={colors.muted}>›</Txt> : null}
      </Row>
    </Pressable>
  );
}

export default function Account() {
  const me = useSession((s) => s.me);
  const signOut = useSession((s) => s.signOut);
  const wallet = useQuery({ queryKey: ["wallet"], queryFn: () => api.get<WalletView>("/v1/wallet") });
  const inbox = useQuery({ queryKey: ["inbox-count"], queryFn: () => api.get<{ unread: number }>("/v1/me/notifications") });
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingBottom: space.xxl }}>
        <Row style={{ paddingVertical: space.md }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={{ paddingRight: space.sm }}>
            <Txt variant="title">‹</Txt>
          </Pressable>
          <View>
            <Txt variant="title">{me ? `${me.firstName} ${me.lastName}` : "Account"}</Txt>
            <Muted>{me?.phone} · ★ {me?.passenger?.ratingAvg ?? "5.00"}</Muted>
          </View>
        </Row>
        <Card style={{ gap: 0, paddingVertical: space.xs }}>
          <Item label="Wallet and cards" sub={wallet.data ? `Balance ${naira(wallet.data.availableBalance)}` : undefined} onPress={() => router.push("/(app)/wallet")} />
          <Divider />
          <Item label="Invite friends" sub="Give ₦500, get ₦500" onPress={() => router.push("/(app)/invite")} />
          <Divider />
          <Item label="Emergency contacts" sub="Texted when you press SOS" onPress={() => router.push("/(app)/contacts")} />
          <Divider />
          <Item label="Notifications" sub={inbox.data?.unread ? `${inbox.data.unread} new` : undefined} onPress={() => router.push("/(app)/notifications")} />
          <Divider />
          <Item label="Help and support" sub="Report a problem" onPress={() => router.push("/(app)/report")} />
        </Card>
        <Card style={{ gap: 0, paddingVertical: space.xs }}>
          <Item label="Sign out" danger onPress={signOut} />
        </Card>
      </ScrollView>
    </Screen>
  );
}
