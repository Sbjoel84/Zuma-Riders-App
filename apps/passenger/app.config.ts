import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Zuma",
  slug: "zuma-passenger",
  scheme: "zuma",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  splash: { image: "./assets/splash-icon.png", resizeMode: "contain", backgroundColor: "#12161b" },
  ios: {
    bundleIdentifier: "com.zuma.passenger",
    supportsTablet: false,
    infoPlist: {
      NSLocationWhenInUseUsageDescription: "Zuma uses your location to set your pickup point and show nearby drivers.",
    },
  },
  android: {
    package: "com.zuma.passenger",
    adaptiveIcon: { foregroundImage: "./assets/android-icon-foreground.png", backgroundImage: "./assets/android-icon-background.png", monochromeImage: "./assets/android-icon-monochrome.png" },
    permissions: ["ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION"],
    config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY } },
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-location", { locationWhenInUsePermission: "Zuma uses your location to set your pickup point and show nearby drivers." }],
  ],
  experiments: { typedRoutes: false },
  extra: { apiUrl: process.env.EXPO_PUBLIC_API_URL },
};

export default config;
