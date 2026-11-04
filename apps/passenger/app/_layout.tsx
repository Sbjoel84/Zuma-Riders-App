import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "@zuma/mobile-core";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 2, staleTime: 5_000 } },
});

export default function RootLayout() {
  const bootstrap = useSession((s) => s.bootstrap);
  useEffect(() => {
    bootstrap("PASSENGER");
  }, [bootstrap]);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#f4f5f1" } }} />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
