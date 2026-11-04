import { useQuery } from "@tanstack/react-query";
import { api, colors, Divider, Muted, Row, Screen, space, Txt } from "@zuma/mobile-core";
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, TextInput, View } from "react-native";
import { useBooking } from "../../src/booking";

interface Suggestion {
  placeId: string;
  primary: string;
  secondary: string;
}

export default function Search() {
  const { editing, pickup, dropoff, setPickup, setDropoff } = useBooking();
  const [q, setQ] = useState(editing === "pickup" ? "" : "");
  const [debounced, setDebounced] = useState("");
  const [picking, setPicking] = useState<string | null>(null);
  const sessionToken = useMemo(() => Crypto.randomUUID(), []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const bias = pickup ? `&lat=${pickup.lat}&lng=${pickup.lng}` : "";
  const results = useQuery({
    queryKey: ["autocomplete", debounced],
    enabled: debounced.length >= 2,
    queryFn: () => api.get<Suggestion[]>(`/v1/maps/autocomplete?input=${encodeURIComponent(debounced)}&sessionToken=${sessionToken}${bias}`),
  });

  const choose = async (s: Suggestion) => {
    setPicking(s.placeId);
    try {
      const d = await api.get<{ address: string; lat: number; lng: number }>(`/v1/maps/place/${encodeURIComponent(s.placeId)}?sessionToken=${sessionToken}`);
      const place = { address: d.address, lat: d.lat, lng: d.lng, placeId: s.placeId };
      if (editing === "pickup") {
        setPickup(place);
        router.back();
      } else {
        setDropoff(place);
        router.replace("/(app)/fare");
      }
    } finally {
      setPicking(null);
    }
  };

  return (
    <Screen>
      <View style={{ gap: space.md, paddingTop: space.md, flex: 1 }}>
        <Row>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={{ padding: space.sm }}>
            <Txt variant="title">‹</Txt>
          </Pressable>
          <Txt variant="heading">{editing === "pickup" ? "Set pickup" : "Where to?"}</Txt>
        </Row>
        {editing === "dropoff" && pickup ? <Muted>From {pickup.address}</Muted> : null}
        <TextInput
          autoFocus
          value={q}
          onChangeText={setQ}
          placeholder={editing === "pickup" ? "Search pickup point" : "Search destination"}
          placeholderTextColor="#8a918a"
          accessibilityLabel={editing === "pickup" ? "Search pickup point" : "Search destination"}
          style={{ minHeight: 52, backgroundColor: "#fff", borderRadius: 12, borderWidth: 2, borderColor: colors.ink, paddingHorizontal: space.md, fontSize: 16, color: colors.ink }}
        />
        {results.isFetching ? <ActivityIndicator color={colors.amber} /> : null}
        {debounced.length >= 2 && results.data?.length === 0 ? <Muted>No places found for "{debounced}". Try a landmark or area name.</Muted> : null}
        {results.isError ? <Muted>Search is unavailable. Check your connection.</Muted> : null}
        <FlatList
          data={results.data ?? []}
          keyExtractor={(i) => i.placeId}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={Divider}
          renderItem={({ item }) => (
            <Pressable accessibilityRole="button" onPress={() => choose(item)} style={{ paddingVertical: space.md, minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.md }}>
              <View style={{ flex: 1 }}>
                <Txt variant="label">{item.primary}</Txt>
                <Muted numberOfLines={1}>{item.secondary}</Muted>
              </View>
              {picking === item.placeId ? <ActivityIndicator color={colors.ink} /> : null}
            </Pressable>
          )}
        />
        {dropoff && editing === "dropoff" ? <Muted>Last destination: {dropoff.address}</Muted> : null}
      </View>
    </Screen>
  );
}
