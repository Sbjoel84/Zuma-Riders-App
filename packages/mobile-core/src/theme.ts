/** Design tokens shared by the passenger and driver apps (same family, driver app runs dark). */
export const colors = {
  ink: "#12161b",
  ground: "#f4f5f1",
  surface: "#ffffff",
  line: "#e1e4dd",
  lineSoft: "#eceee9",
  muted: "#5d645c",
  amber: "#f2a900",
  amberSoft: "#fff6dd",
  amberText: "#7a4a00",
  green: "#1f7a4f",
  greenSoft: "#e2f3ea",
  red: "#b3261e",
  redSoft: "#fbe5e3",
  blue: "#1d4f8a",
  blueSoft: "#e3eefb",
  map: "#e6e9e2",
  night: "#12161b",
  nightSurface: "#1a1f25",
  nightLine: "#262c33",
  nightText: "#f1f3ee",
  nightMuted: "#a9b0a8",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 };
export const radius = { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 };

export const type = {
  display: { fontSize: 34, fontWeight: "700" as const, letterSpacing: -0.3 },
  title: { fontSize: 22, fontWeight: "700" as const },
  heading: { fontSize: 17, fontWeight: "700" as const },
  body: { fontSize: 15, fontWeight: "400" as const },
  label: { fontSize: 13, fontWeight: "600" as const },
  small: { fontSize: 12, fontWeight: "500" as const },
};
