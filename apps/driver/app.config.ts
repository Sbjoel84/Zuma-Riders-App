import type { ExpoConfig } from "expo/config";

const LOCATION_COPY = "Riders App Driver uses your location to send you nearby ride requests and to share your position with your passenger during a trip.";

const config: ExpoConfig = {
  name: "Riders App Driver",
  slug: "zuma-driver",
  scheme: "zumadriver",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "dark",
  ios: {
    bundleIdentifier: "com.zuma.driver",
    supportsTablet: false,
    infoPlist: {
      NSLocationWhenInUseUsageDescription: LOCATION_COPY,
      NSLocationAlwaysAndWhenInUseUsageDescription: LOCATION_COPY + " Location continues while you're online, even with the app in the background.",
      UIBackgroundModes: ["location"],
    },
  },
  android: {
    package: "com.zuma.driver",
    adaptiveIcon: { foregroundImage: "./assets/android-icon-foreground.png", backgroundImage: "./assets/android-icon-background.png", monochromeImage: "./assets/android-icon-monochrome.png" },
    permissions: ["ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION", "ACCESS_BACKGROUND_LOCATION", "FOREGROUND_SERVICE", "FOREGROUND_SERVICE_LOCATION", "POST_NOTIFICATIONS", "CAMERA"],
    config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY } },
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-splash-screen", { image: "./assets/splash-icon.png", imageWidth: 160, resizeMode: "contain", backgroundColor: "#12161b" }],
    ["expo-location", { locationAlwaysAndWhenInUsePermission: LOCATION_COPY, isAndroidBackgroundLocationEnabled: true, isAndroidForegroundServiceEnabled: true }],
    ["expo-notifications", { color: "#f2a900" }],
    ["expo-image-picker", { cameraPermission: "Riders App Driver uses the camera to photograph your licence, vehicle papers and car for verification.", photosPermission: "Choose photos of your documents for verification." }],
    "expo-web-browser",
  ],
  extra: { apiUrl: process.env.EXPO_PUBLIC_API_URL, eas: { projectId: process.env.EAS_PROJECT_ID } },
};

export default config;
