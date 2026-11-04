import "../src/location"; // registers the background location task at startup
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { colors, ThemeContext, useSession } from "@zuma/mobile-core";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 2, staleTime: 5_000 } } });

export default function RootLayout() {
  const bootstrap = useSession((s) => s.bootstrap);
  useEffect(() => {
    bootstrap("DRIVER");
  }, [bootstrap]);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeContext.Provider value={{ dark: true }}>
          <StatusBar style="light" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.night } }} />
        </ThemeContext.Provider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
