import "leaflet/dist/leaflet.css";
import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { FeedbackProvider, Spinner } from "./components/ui";
import { Layout } from "./components/Layout";
import { ApiError } from "./lib/api";
import { AuthProvider, useAuth } from "./lib/auth";
import { Login } from "./pages/Login";

const Drivers = lazy(() => import("./pages/Drivers").then((m) => ({ default: m.Drivers })));
const Finance = lazy(() => import("./pages/Finance").then((m) => ({ default: m.Finance })));
const LiveMap = lazy(() => import("./pages/LiveMap").then((m) => ({ default: m.LiveMap })));
const Overview = lazy(() => import("./pages/Overview").then((m) => ({ default: m.Overview })));
const Passengers = lazy(() => import("./pages/Passengers").then((m) => ({ default: m.Passengers })));
const Pricing = lazy(() => import("./pages/Pricing").then((m) => ({ default: m.Pricing })));
const Rides = lazy(() => import("./pages/Rides").then((m) => ({ default: m.Rides })));
const Safety = lazy(() => import("./pages/Safety").then((m) => ({ default: m.Safety })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Support = lazy(() => import("./pages/Support").then((m) => ({ default: m.Support })));
const Verification = lazy(() => import("./pages/Verification").then((m) => ({ default: m.Verification })));
const Promotions = lazy(() => import("./pages/Promotions").then((m) => ({ default: m.Promotions })));
const Security = lazy(() => import("./pages/Security").then((m) => ({ default: m.Security })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: (n, e) => !(e instanceof ApiError && [401, 403, 404, 422].includes(e.status)) && n < 2,
      refetchOnWindowFocus: true,
    },
  },
});

function Gate() {
  const { status } = useAuth();
  if (status === "loading") return <Spinner label="Signing you in…" />;
  if (status === "signedOut") return <Login />;
  if (status === "mfaSetup") return <Suspense fallback={<Spinner />}><Security enrolOnly /></Suspense>;
  return (
    <Suspense fallback={<Spinner />}>
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="live" element={<LiveMap />} />
        <Route path="rides" element={<Rides />} />
        <Route path="rides/:id" element={<Rides />} />
        <Route path="drivers" element={<Drivers />} />
        <Route path="verification" element={<Verification />} />
        <Route path="passengers" element={<Passengers />} />
        <Route path="finance" element={<Finance />} />
        <Route path="pricing" element={<Pricing />} />
        <Route path="support" element={<Support />} />
        <Route path="support/:id" element={<Support />} />
        <Route path="safety" element={<Safety />} />
        <Route path="promotions" element={<Promotions />} />
        <Route path="settings" element={<Settings />} />
        <Route path="security" element={<Security />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <FeedbackProvider>
          <AuthProvider>
            <Gate />
          </AuthProvider>
        </FeedbackProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
