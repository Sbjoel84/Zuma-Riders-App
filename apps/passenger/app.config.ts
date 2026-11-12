import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Riders App",
  slug: "zuma-passenger",
  scheme: "zuma",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: "com.zuma.passenger",
    supportsTablet: false,
    infoPlist: {
      NSLocationWhenInUseUsageDescription: "Riders App uses your location to set your pickup point and show nearby drivers.",
    },
  },
  android: {
    package: "com.zuma.passenger",
    adaptiveIcon: { foregroundImage: "./assets/android-icon-foreground.png", backgroundImage: "./assets/android-icon-background.png", monochromeImage: "./assets/android-icon-monochrome.png" },
    permissions: ["ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION", "POST_NOTIFICATIONS"],
    config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY } },
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-splash-screen", { image: "./assets/splash-icon.png", imageWidth: 160, resizeMode: "contain", backgroundColor: "#12161b" }],
    ["expo-location", { locationWhenInUsePermission: "Riders App uses your location to set your pickup point and show nearby drivers." }],
    ["expo-notifications", { color: "#f2a900" }],
    "expo-web-browser",
  ],
  experiments: { typedRoutes: false },
  extra: { apiUrl: process.env.EXPO_PUBLIC_API_URL, eas: { projectId: process.env.EAS_PROJECT_ID } },
};

export default config;
