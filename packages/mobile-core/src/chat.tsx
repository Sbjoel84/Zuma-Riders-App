import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import React, { useEffect, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { api, errorMessage } from "./api";
import { useServerEvent } from "./realtime";
import { colors, radius, space, type } from "./theme";
import { Banner, Muted, Row, Screen, Txt, ThemeContext } from "./ui";

export interface ChatMessage {
  id: string;
  clientMessageId: string;
  type: string;
  body: string | null;
  imageUrl: string | null;
  fromMe: boolean;
  senderRole: "PASSENGER" | "DRIVER" | "SYSTEM";
  createdAt: string;
  pending?: boolean;
  failed?: boolean;
}

interface Thread {
  open: boolean;
  otherName: string;
  messages: ChatMessage[];
}

/**
 * Trip chat for both apps. Messages arrive over the socket; sending is a REST call with a client id,
 * so a retry after a network drop never duplicates a message.
 */
export function TripChat({ rideId, quickReplies, onBack }: { rideId: string; quickReplies: string[]; onBack: () => void }) {
  const dark = React.useContext(ThemeContext).dark;
  const qc = useQueryClient();
  const key = ["chat", rideId];
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = useRef<FlatList<ChatMessage>>(null);
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Thread>(`/v1/rides/${rideId}/messages`), refetchInterval: 30_000 });

  const markRead = () => void api.post(`/v1/rides/${rideId}/messages/read`).then(() => qc.invalidateQueries({ queryKey: ["ride", rideId] })).catch(() => undefined);
  useEffect(markRead, [rideId]);

  const merge = (m: ChatMessage) =>
    qc.setQueryData<Thread>(key, (t) => {
      if (!t) return t;
      const rest = t.messages.filter((x) => x.clientMessageId !== m.clientMessageId && x.id !== m.id);
      return { ...t, messages: [...rest, m].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
    });

  useServerEvent<{ rideId: string; message: ChatMessage }>("chat.message", (e) => {
    if (e.rideId !== rideId) return;
    merge(e.message);
    if (!e.message.fromMe) markRead();
  });

  useEffect(() => {
    if (q.data?.messages.length) setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50);
  }, [q.data?.messages.length]);

  const send = async (body: string, quickReply = false, retryOf?: ChatMessage) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    const clientMessageId = retryOf?.clientMessageId ?? Crypto.randomUUID();
    merge({ id: clientMessageId, clientMessageId, type: "TEXT", body: trimmed, imageUrl: null, fromMe: true, senderRole: "SYSTEM", createdAt: retryOf?.createdAt ?? new Date().toISOString(), pending: true });
    if (!retryOf) setText("");
    setError(null);
    try {
      const saved = await api.post<ChatMessage>(`/v1/rides/${rideId}/messages`, { clientMessageId, body: trimmed, quickReply });
      merge(saved);
    } catch (e) {
      merge({ id: clientMessageId, clientMessageId, type: "TEXT", body: trimmed, imageUrl: null, fromMe: true, senderRole: "SYSTEM", createdAt: retryOf?.createdAt ?? new Date().toISOString(), failed: true });
      setError(errorMessage(e));
    }
  };

  const bg = dark ? colors.night : colors.ground;
  const bubbleOther = dark ? colors.nightSurface : colors.surface;
  return (
    <Screen padded={false} style={{ backgroundColor: bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Row style={{ padding: space.lg, borderBottomWidth: 1, borderBottomColor: dark ? colors.nightLine : colors.lineSoft }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={{ paddingRight: space.sm }}>
            <Txt variant="title">‹</Txt>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Txt variant="heading">{q.data?.otherName ?? "Chat"}</Txt>
            <Muted>Messages stay in Zuma. Don't share bank details or passwords.</Muted>
          </View>
        </Row>
        <FlatList
          ref={list}
          data={q.data?.messages ?? []}
          keyExtractor={(m) => m.clientMessageId}
          contentContainerStyle={{ padding: space.lg, gap: space.sm, flexGrow: 1 }}
          ListEmptyComponent={<Muted center style={{ marginTop: space.xxl }}>{q.isLoading ? "Loading…" : "No messages yet. Say hello or use a quick reply."}</Muted>}
          renderItem={({ item: m }) => (
            <Pressable
              disabled={!m.failed}
              onPress={() => m.body && send(m.body, false, m)}
              accessibilityLabel={m.failed ? "Message not sent. Tap to retry." : undefined}
              style={{
                alignSelf: m.fromMe ? "flex-end" : "flex-start", maxWidth: "82%", borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm,
                backgroundColor: m.fromMe ? (dark ? colors.amber : colors.ink) : bubbleOther, opacity: m.pending ? 0.6 : 1,
                borderWidth: m.failed ? 1 : 0, borderColor: colors.red,
              }}
            >
              <Txt color={m.fromMe ? (dark ? colors.ink : "#fff") : undefined}>{m.imageUrl ? "Photo" : m.body}</Txt>
              <Txt variant="small" color={m.fromMe ? (dark ? colors.ink : "#c9cec7") : colors.muted} style={{ marginTop: 2 }}>
                {m.failed ? "Not sent · tap to retry" : m.pending ? "Sending…" : new Date(m.createdAt).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}
              </Txt>
            </Pressable>
          )}
        />
        {error ? <View style={{ paddingHorizontal: space.lg }}><Banner text={error} /></View> : null}
        {q.data && !q.data.open ? (
          <View style={{ padding: space.lg }}><Banner tone="amber" text="Chat for this trip has closed. Use Report a problem if you need help." /></View>
        ) : (
          <View style={{ padding: space.md, gap: space.sm, borderTopWidth: 1, borderTopColor: dark ? colors.nightLine : colors.lineSoft }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }} keyboardShouldPersistTaps="handled">
              {quickReplies.map((r) => (
                <Pressable key={r} accessibilityRole="button" onPress={() => send(r, true)} style={{ borderWidth: 1, borderColor: dark ? colors.nightLine : colors.line, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 8 }}>
                  <Txt variant="label">{r}</Txt>
                </Pressable>
              ))}
            </ScrollView>
            <Row gap={space.sm}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Message"
                placeholderTextColor={dark ? colors.nightMuted : "#8a918a"}
                maxLength={500}
                multiline
                accessibilityLabel="Message"
                style={[type.body, { flex: 1, minHeight: 46, maxHeight: 120, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: 12, backgroundColor: dark ? colors.nightSurface : colors.surface, color: dark ? colors.nightText : colors.ink }]}
              />
              <Pressable accessibilityRole="button" accessibilityLabel="Send" onPress={() => send(text)} disabled={!text.trim()} style={{ height: 46, paddingHorizontal: space.lg, borderRadius: 23, backgroundColor: text.trim() ? colors.amber : colors.line, alignItems: "center", justifyContent: "center" }}>
                <Txt variant="label" color={colors.ink}>Send</Txt>
              </Pressable>
            </Row>
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}
