import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, radius, space, type } from "./theme";

export const ThemeContext = React.createContext<{ dark: boolean }>({ dark: false });
const useDark = () => React.useContext(ThemeContext).dark;

export function Screen({ children, style, dark, padded = true, edges }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; dark?: boolean; padded?: boolean; edges?: ("top" | "bottom" | "left" | "right")[] }) {
  const ctxDark = useDark();
  const isDark = dark ?? ctxDark;
  return (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: isDark ? colors.night : colors.ground }, padded && { paddingHorizontal: space.lg }, style]}>
      {children}
    </SafeAreaView>
  );
}

type Variant = keyof typeof type;
export function Txt({ children, variant = "body", color, style, numberOfLines, center }: { children: React.ReactNode; variant?: Variant; color?: string; style?: StyleProp<TextStyle>; numberOfLines?: number; center?: boolean }) {
  const isDark = useDark();
  return (
    <Text numberOfLines={numberOfLines} style={[type[variant], { color: color ?? (isDark ? colors.nightText : colors.ink) }, center && { textAlign: "center" }, variant !== "body" && variant !== "small" ? null : { lineHeight: type[variant].fontSize * 1.4 }, style]}>
      {children}
    </Text>
  );
}

export function Muted(props: { children: React.ReactNode; variant?: Variant; style?: StyleProp<TextStyle>; center?: boolean; numberOfLines?: number }) {
  const isDark = useDark();
  return <Txt {...props} variant={props.variant ?? "small"} color={isDark ? colors.nightMuted : colors.muted} />;
}

type ButtonKind = "primary" | "secondary" | "ghost" | "danger" | "amber";
export function Button({ title, onPress, kind = "primary", loading, disabled, style, accessibilityLabel }: { title: string; onPress?: () => void; kind?: ButtonKind; loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>; accessibilityLabel?: string }) {
  const isDark = useDark();
  const palette: Record<ButtonKind, { bg: string; fg: string; border: string }> = {
    primary: isDark ? { bg: colors.amber, fg: colors.ink, border: colors.amber } : { bg: colors.ink, fg: "#fff", border: colors.ink },
    amber: { bg: colors.amber, fg: colors.ink, border: colors.amber },
    secondary: isDark ? { bg: "transparent", fg: colors.nightText, border: colors.nightLine } : { bg: colors.surface, fg: colors.ink, border: colors.line },
    ghost: { bg: "transparent", fg: isDark ? colors.nightMuted : colors.muted, border: "transparent" },
    danger: { bg: "transparent", fg: colors.red, border: "transparent" },
  };
  const p = palette[kind];
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [s.btn, { backgroundColor: p.bg, borderColor: p.border, opacity: off ? 0.5 : pressed ? 0.85 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={p.fg} /> : <Text style={[type.heading, { color: p.fg, fontSize: 16 }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, error, hint, style, ...input }: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  const isDark = useDark();
  return (
    <View style={[{ gap: 6 }, style as StyleProp<ViewStyle>]}>
      <Txt variant="label">{label}</Txt>
      <TextInput
        placeholderTextColor={isDark ? colors.nightMuted : "#8a918a"}
        accessibilityLabel={label}
        {...input}
        style={[s.input, { backgroundColor: isDark ? colors.nightSurface : colors.surface, color: isDark ? colors.nightText : colors.ink, borderColor: error ? colors.red : isDark ? colors.nightLine : colors.line }]}
      />
      {error ? <Txt variant="small" color={colors.red}>{error}</Txt> : hint ? <Muted>{hint}</Muted> : null}
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const isDark = useDark();
  return <View style={[s.card, { backgroundColor: isDark ? colors.nightSurface : colors.surface, borderColor: isDark ? colors.nightLine : colors.lineSoft }, style]}>{children}</View>;
}

export function Pill({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "amber" | "green" | "red" | "blue" }) {
  const t = { neutral: [colors.lineSoft, "#3d443c"], amber: [colors.amberSoft, colors.amberText], green: [colors.greenSoft, "#1f6b45"], red: [colors.redSoft, "#8c1d17"], blue: [colors.blueSoft, colors.blue] }[tone];
  return (
    <View style={{ backgroundColor: t[0], paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill, alignSelf: "flex-start" }}>
      <Text style={[type.small, { color: t[1], fontWeight: "600" }]}>{label}</Text>
    </View>
  );
}

export function Banner({ text, tone = "red" }: { text: string; tone?: "red" | "amber" | "green" }) {
  const t = { red: [colors.redSoft, "#8c1d17"], amber: [colors.amberSoft, colors.amberText], green: [colors.greenSoft, "#1f6b45"] }[tone];
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: t[0], padding: space.md, borderRadius: radius.md }}>
      <Text style={[type.label, { color: t[1] }]}>{text}</Text>
    </View>
  );
}

export function Chip({ label, selected, onPress, sub }: { label: string; selected: boolean; onPress: () => void; sub?: string }) {
  const isDark = useDark();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={[s.chip, selected ? { backgroundColor: isDark ? colors.amberSoft : colors.ink, borderColor: isDark ? colors.amber : colors.ink } : { backgroundColor: isDark ? colors.nightSurface : colors.surface, borderColor: isDark ? colors.nightLine : colors.line }]}
    >
      <Text style={[type.label, { color: selected ? (isDark ? colors.ink : "#fff") : isDark ? colors.nightText : colors.ink }]}>{label}</Text>
      {sub ? <Text style={[type.small, { color: selected ? (isDark ? colors.ink : "#d6d9d2") : colors.muted }]}>{sub}</Text> : null}
    </Pressable>
  );
}

export function Stepper({ value, onDec, onInc, decLabel, incLabel }: { value: string; onDec: () => void; onInc: () => void; decLabel: string; incLabel: string }) {
  return (
    <View style={s.stepper}>
      <Pressable accessibilityRole="button" accessibilityLabel={decLabel} onPress={onDec} style={s.stepBtn}>
        <Text style={{ fontSize: 26, fontWeight: "600", color: colors.ink }}>−</Text>
      </Pressable>
      <Text style={[type.display, { flex: 1, textAlign: "center", color: colors.ink, fontVariant: ["tabular-nums"] }]}>{value}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={incLabel} onPress={onInc} style={s.stepBtn}>
        <Text style={{ fontSize: 26, fontWeight: "600", color: colors.ink }}>+</Text>
      </Pressable>
    </View>
  );
}

export function Row({ children, style, gap = space.md }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap }, style]}>{children}</View>;
}

export function Divider() {
  const isDark = useDark();
  return <View style={{ height: 1, backgroundColor: isDark ? colors.nightLine : colors.lineSoft }} />;
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.md }}>
      <ActivityIndicator color={colors.amber} size="large" />
      {label ? <Muted>{label}</Muted> : null}
    </View>
  );
}

const s = StyleSheet.create({
  btn: { minHeight: 52, borderRadius: radius.lg, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: space.lg },
  input: { minHeight: 52, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: 16 },
  card: { borderRadius: radius.lg, borderWidth: 1, padding: space.lg, gap: space.md },
  chip: { minHeight: 64, flex: 1, borderRadius: radius.md, borderWidth: 2, alignItems: "center", justifyContent: "center", paddingVertical: space.sm, gap: 2 },
  stepper: { flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: colors.ground, borderRadius: radius.lg, padding: space.sm },
  stepBtn: { width: 52, height: 52, borderRadius: radius.md, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
});
