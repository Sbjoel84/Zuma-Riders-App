import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { todayLabel } from "../lib/format";

export interface Attention {
  pendingVerification: number;
  openTickets: number;
  openIncidents: number;
  pendingWithdrawals: number;
  disputedRides: number;
}

const NAV: { to: string; label: string; perm: string; badge?: keyof Attention; urgent?: boolean }[] = [
  { to: "/", label: "Overview", perm: "dashboard:read" },
  { to: "/live", label: "Live map", perm: "ops:live" },
  { to: "/rides", label: "Rides", perm: "rides:read", badge: "disputedRides" },
  { to: "/drivers", label: "Drivers", perm: "drivers:read" },
  { to: "/verification", label: "Verification", perm: "drivers:verify", badge: "pendingVerification" },
  { to: "/passengers", label: "Passengers", perm: "passengers:read" },
  { to: "/finance", label: "Finance", perm: "finance:read", badge: "pendingWithdrawals" },
  { to: "/pricing", label: "Pricing", perm: "dashboard:read" },
  { to: "/promotions", label: "Promotions", perm: "marketing:write" },
  { to: "/support", label: "Support", perm: "support:write", badge: "openTickets" },
  { to: "/safety", label: "Safety", perm: "safety:write", badge: "openIncidents", urgent: true },
  { to: "/settings", label: "Settings", perm: "dashboard:read" },
];

export function Layout() {
  const { me, can, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);

  // Badge counts refresh every 20 s; safety incidents are the reason this polls.
  const attention = useQuery({
    queryKey: ["attention"],
    queryFn: async () => (await api.get<{ attention: Attention }>("/v1/admin/metrics/overview")).attention,
    refetchInterval: 20_000,
    enabled: can("dashboard:read"),
  });

  const items = NAV.filter((n) => can(n.perm));
  const sos = attention.data?.openIncidents ?? 0;

  return (
    <div className="flex min-h-full">
      <aside className={clsx("fixed inset-y-0 left-0 z-40 flex w-[232px] flex-col gap-5 bg-ink px-4 py-6 text-[#f1f3ee] transition-transform lg:static lg:translate-x-0", open ? "translate-x-0" : "-translate-x-full")}>
        <div className="flex items-center justify-between">
          <span className="font-display text-[22px] font-bold">zuma</span>
          <span className="rounded-md bg-amber px-2 py-0.5 text-[11px] font-bold tracking-wider text-ink uppercase">Ops</span>
          <button className="cursor-pointer text-[#c9cec7] lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu"><X className="size-5" /></button>
        </div>
        <nav aria-label="Sections" className="flex flex-col gap-0.5">
          {items.map((n) => {
            const count = n.badge ? attention.data?.[n.badge] : undefined;
            return (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === "/"}
                className={({ isActive }) => clsx("flex min-h-10 items-center justify-between rounded-[10px] px-3 text-sm font-semibold", isActive ? "bg-ink-2 text-white" : "text-[#c9cec7] hover:text-white")}
              >
                {n.label}
                {count ? <span className={clsx("rounded-full px-2 py-0.5 text-xs font-bold", n.urgent ? "bg-bad text-white" : "bg-amber text-ink")}>{count}</span> : null}
              </NavLink>
            );
          })}
        </nav>
        <div className="mt-auto flex flex-col gap-2 text-xs text-[#a9b0a8]">
          <span>
            {me?.name}
            <br />
            {me?.roles.map((r) => r.name).join(", ")}
          </span>
          <span className="flex gap-3">
            <NavLink to="/security" className="font-semibold text-[#f1f3ee] underline">Security</NavLink>
            <button onClick={signOut} className="cursor-pointer font-semibold text-[#f1f3ee] underline">Sign out</button>
          </span>
        </div>
      </aside>
      {open ? <div className="fixed inset-0 z-30 bg-ink/40 lg:hidden" onClick={() => setOpen(false)} /> : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-line bg-white px-4 py-2.5 lg:hidden">
          <button onClick={() => setOpen(true)} className="cursor-pointer" aria-label="Open menu"><Menu className="size-6" /></button>
          <span className="font-display font-bold">zuma ops</span>
          <span className="w-6" />
        </div>
        {sos > 0 && !loc.pathname.startsWith("/safety") && can("safety:write") ? (
          <NavLink to="/safety" className="flex items-center gap-2 bg-bad px-4 py-2.5 text-sm font-bold text-white lg:px-10">
            <span className="size-2 animate-pulse rounded-full bg-white" />
            {sos} open safety incident{sos > 1 ? "s" : ""}. Open the safety queue.
          </NavLink>
        ) : null}
        <main className="mx-auto flex w-full max-w-[1400px] min-w-0 flex-col gap-6 px-4 py-7 lg:px-10">
          <p className="-mb-4 text-[13px] text-muted">Abuja · {todayLabel()}</p>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
