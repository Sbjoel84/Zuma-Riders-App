// Web-preview stand-in for react-native-maps: a drawn street map with markers placed by coordinates.
import React, { forwardRef, useImperativeHandle, useState } from "react";
import { View, Text } from "react-native";

type Region = { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };
const Ctx = React.createContext<{ region: Region; w: number; h: number } | null>(null);

function project(r: Region, w: number, h: number, lat: number, lng: number) {
  const x = ((lng - (r.longitude - r.longitudeDelta / 2)) / r.longitudeDelta) * w;
  const y = (((r.latitude + r.latitudeDelta / 2) - lat) / r.latitudeDelta) * h;
  return { x, y };
}

const MapView = forwardRef<any, any>(function MapView({ initialRegion, region: controlled, style, children }, ref) {
  const [region, setRegion] = useState<Region>(controlled ?? initialRegion ?? { latitude: 9.0579, longitude: 7.4951, latitudeDelta: 0.06, longitudeDelta: 0.06 });
  const [size, setSize] = useState({ w: 390, h: 844 });
  useImperativeHandle(ref, () => ({
    animateToRegion: (r: Region) => setRegion(r),
    animateCamera: () => undefined,
    fitToCoordinates: (pts: { latitude: number; longitude: number }[]) => {
      if (!pts.length) return;
      const lats = pts.map((p) => p.latitude), lngs = pts.map((p) => p.longitude);
      const minLa = Math.min(...lats), maxLa = Math.max(...lats), minLn = Math.min(...lngs), maxLn = Math.max(...lngs);
      const dLat = Math.max(0.01, (maxLa - minLa) * 3.2), dLng = Math.max(0.01, (maxLn - minLn) * 1.6);
      // Bias upward: the bottom sheet covers the lower half of the screen.
      setRegion({ latitude: (minLa + maxLa) / 2 - dLat * 0.18, longitude: (minLn + maxLn) / 2, latitudeDelta: dLat, longitudeDelta: dLng });
    },
  }));
  const { w, h } = size;
  const streets: React.ReactNode[] = [];
  const step = region.latitudeDelta / 9;
  const gaps = [0.9, 1.4, 0.7, 1.1, 1.6, 0.8, 1.2, 1.0, 1.5, 0.75, 1.3];
  let y = -20, k = 0;
  while (y < h + 40) {
    streets.push(<View key={`h${k}`} style={{ position: "absolute", left: 0, right: 0, top: y, height: k % 4 === 1 ? 10 : 5, backgroundColor: "#ffffff", transform: [{ rotate: `${(k % 3) - 1}deg` }] }} />);
    y += gaps[k % gaps.length]! * 78; k++;
  }
  let x = -10; k = 0;
  while (x < w + 40) {
    streets.push(<View key={`v${k}`} style={{ position: "absolute", top: -40, bottom: -40, left: x, width: k % 3 === 2 ? 10 : 5, backgroundColor: "#ffffff", transform: [{ rotate: `${((k * 7) % 5) - 2}deg` }] }} />);
    x += gaps[(k + 4) % gaps.length]! * 82; k++;
  }
  void step;
  return (
    <View style={[{ backgroundColor: "#e9ece4", overflow: "hidden" }, style]} onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      <View style={{ position: "absolute", left: w * 0.62, top: h * 0.08, width: w * 0.3, height: h * 0.16, borderRadius: 40, backgroundColor: "#d5e5c8" }} />
      <View style={{ position: "absolute", left: w * 0.05, top: h * 0.42, width: w * 0.22, height: h * 0.1, borderRadius: 30, backgroundColor: "#d5e5c8" }} />
      {streets}
      <View style={{ position: "absolute", left: -w * 0.2, top: h * 0.3, width: w * 1.5, height: 14, backgroundColor: "#f6dfa0", transform: [{ rotate: "-18deg" }] }} />
      <Ctx.Provider value={{ region, w, h }}>{children}</Ctx.Provider>
      <Text style={{ position: "absolute", right: 8, bottom: 4, fontSize: 9, color: "#8a918a" }}>Map preview</Text>
    </View>
  );
});

export function Marker({ coordinate, children, pinColor, anchor }: any) {
  const c = React.useContext(Ctx);
  if (!c) return null;
  const { x, y } = project(c.region, c.w, c.h, coordinate.latitude, coordinate.longitude);
  if (children) {
    return <View style={{ position: "absolute", left: x, top: y, width: 0, height: 0, alignItems: "center", justifyContent: anchor ? "center" : "flex-end", overflow: "visible" }}><View style={{ position: "absolute" }}>{children}</View></View>;
  }
  return (
    <View style={{ position: "absolute", left: x - 11, top: y - 30, alignItems: "center" }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: pinColor ?? "#b3261e", borderWidth: 3, borderColor: "#fff" }} />
      <View style={{ width: 3, height: 9, backgroundColor: pinColor ?? "#b3261e" }} />
    </View>
  );
}
export const Polyline = () => null;
export const Circle = () => null;
export const PROVIDER_GOOGLE = "google";
export default MapView;
