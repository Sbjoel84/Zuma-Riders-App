import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Async, Badge, Card, Empty, Kpi, PageHeader, Table, Td } from "../components/ui";
import type { Attention } from "../components/Layout";
import { api } from "../lib/api";
import { naira, pct, time } from "../lib/format";
import { RIDE_STATUS } from "../lib/status";

interface Overview {
  kpis: {
    activeTrips: number; onlineDrivers: number; openRequests: number; completedToday: number; completedYesterday: number; cancelledToday: number;
    cancellationRate: number; commissionToday: string; commissionYesterday: string; grossToday: string; cashGrossToday: string; walletLiabilities: string; cashCommissionOwed: string;
  };
  byHour: { hour: number; rides: number }[];
  byDay: { date: string; rides: number; gross: string }[];
  attention: Attention;
}

interface RideRow { id: string; code: string; status: string; passenger: string; driver: string; pickup: string; dropoff: string; proposedFare: string; agreedFare: string; createdAt: string }

function delta(today: number, yesterday: number) {
  if (!yesterday) return today ? "First rides vs none yesterday" : "Same as yesterday";
  const d = ((today - yesterday) / yesterday) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}% vs yesterday`;
}

export function Overview() {
  const q = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/v1/admin/metrics/overview"), refetchInterval: 15_000 });
  const rides = useQuery({ queryKey: ["rides", "recent"], queryFn: () => api.get<{ data: RideRow[] }>("/v1/admin/rides?limit=8") });

  return (
    <>
      <PageHeader title="Abuja operations" subtitle="Live figures for today, refreshed every 15 seconds" />
      <Async q={q} loading="Loading today's figures…">
        {(o) => {
          const k = o.kpis;
          const commToday = BigInt(k.commissionToday);
          const commY = BigInt(k.commissionYesterday);
          const peak = Math.max(...o.byHour.map((h) => h.rides));
          const attention = [
            { n: o.attention.openIncidents, text: "open safety incident", to: "/safety", tone: "red" as const },
            { n: o.attention.pendingVerification, text: "driver waiting for verification", to: "/verification", tone: "amber" as const },
            { n: o.attention.pendingWithdrawals, text: "withdrawal to approve or pay", to: "/finance", tone: "amber" as const },
            { n: o.attention.openTickets, text: "open support ticket", to: "/support", tone: "amber" as const },
            { n: o.attention.disputedRides, text: "disputed ride", to: "/rides?group=disputed", tone: "violet" as const },
          ].filter((a) => a.n > 0);
          return (
            <>
              <section aria-label="Key figures" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
                <Kpi label="Active trips" value={k.activeTrips} note={`${k.openRequests} request${k.openRequests === 1 ? "" : "s"} looking for drivers`} />
                <Kpi label="Drivers online" value={k.onlineDrivers} note="Online or on a trip" />
                <Kpi label="Completed today" value={k.completedToday} note={delta(k.completedToday, k.completedYesterday)} tone={k.completedToday >= k.completedYesterday ? "up" : "down"} />
                <Kpi label="Cancellation rate" value={pct(k.cancellationRate)} note={`${k.cancelledToday} cancelled today`} tone={k.cancellationRate > 0.1 ? "down" : "muted"} />
                <Kpi label="Commission today" value={naira(k.commissionToday, { compact: true })} note={commY ? `${commToday >= commY ? "+" : "−"}${naira((commToday >= commY ? commToday - commY : commY - commToday).toString())} vs yesterday` : `${naira(k.grossToday, { compact: true })} gross bookings`} tone={commToday >= commY ? "up" : "down"} />
                <Kpi label="Wallet liabilities" value={naira(k.walletLiabilities, { compact: true })} note={`Drivers owe ${naira(k.cashCommissionOwed)} cash commission`} />
              </section>

              <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
                <Card title="Completed rides by hour" actions={<span className="text-xs text-muted">Today, Lagos time</span>}>
                  {peak === 0 ? (
                    <Empty title="No completed rides yet today" body="The chart fills in as trips complete." />
                  ) : (
                    <div className="h-[220px]" role="img" aria-label={`Completed rides per hour today, peak ${peak}`}>
                      <ResponsiveContainer>
                        <BarChart data={o.byHour} margin={{ top: 8, right: 4, left: -24, bottom: 0 }}>
                          <CartesianGrid vertical={false} stroke="#eceee9" />
                          <XAxis dataKey="hour" tickFormatter={(h) => `${String(h).padStart(2, "0")}`} tick={{ fontSize: 11, fill: "#5d645c" }} axisLine={false} tickLine={false} interval={2} />
                          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#5d645c" }} axisLine={false} tickLine={false} />
                          <Tooltip cursor={{ fill: "#f4f5f1" }} formatter={(v) => [`${v} rides`, ""]} labelFormatter={(h) => `${String(h).padStart(2, "0")}:00`} />
                          <Bar dataKey="rides" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                            {o.byHour.map((h) => <Cell key={h.hour} fill={h.rides === peak ? "#f2a900" : "#12161b"} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </Card>

                <Card title="Needs attention">
                  {attention.length === 0 ? (
                    <Empty title="Nothing waiting" body="No open incidents, verifications, payouts, tickets or disputes." />
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {attention.map((a) => (
                        <li key={a.to}>
                          <Link to={a.to} className="flex items-center gap-3 rounded-[10px] bg-[#f8f9f6] px-3 py-2.5 hover:bg-line-soft">
                            <span className={`size-2.5 flex-none rounded-full ${a.tone === "red" ? "bg-bad" : a.tone === "violet" ? "bg-violet" : "bg-amber"}`} />
                            <span className="flex-1 text-sm font-semibold">{a.n} {a.text}{a.n > 1 ? "s" : ""}</span>
                            <span className="text-xs font-semibold text-muted">Open</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>

              <Card title="Last 7 days">
                <div className="grid grid-cols-7 gap-2 text-center">
                  {o.byDay.map((d) => {
                    const max = Math.max(1, ...o.byDay.map((x) => x.rides));
                    return (
                      <div key={d.date} className="flex flex-col items-center gap-1.5">
                        <div className="flex h-24 w-full items-end justify-center">
                          <div className="w-full max-w-10 rounded-t bg-ink" style={{ height: `${Math.max(2, (d.rides / max) * 100)}%` }} title={`${d.rides} rides`} />
                        </div>
                        <span className="tabular text-sm font-bold">{d.rides}</span>
                        <span className="text-[11px] text-muted">{new Date(d.date).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", weekday: "short" })}</span>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </>
          );
        }}
      </Async>

      <Card title="Recent rides" pad={false} actions={<Link to="/rides" className="text-sm font-semibold underline">View all rides</Link>}>
        <Async q={rides}>
          {(r) =>
            r.data.length === 0 ? (
              <Empty title="No rides yet" body="Rides appear here once a passenger accepts a driver's offer." />
            ) : (
              <Table head={["Ride", "Passenger", "Driver", "Route", "Proposed → agreed", "Status", "Time"]} minWidth={860}>
                {r.data.map((x) => (
                  <tr key={x.id}>
                    <Td><Link to={`/rides/${x.id}`} className="font-bold underline">{x.code}</Link></Td>
                    <Td>{x.passenger}</Td>
                    <Td>{x.driver}</Td>
                    <Td className="max-w-[280px] truncate text-[#3d443c]">{x.pickup.split(",")[0]} → {x.dropoff.split(",")[0]}</Td>
                    <Td className="tabular">{naira(x.proposedFare)} → {naira(x.agreedFare)}</Td>
                    <Td><Badge tone={RIDE_STATUS[x.status]?.tone}>{RIDE_STATUS[x.status]?.label ?? x.status}</Badge></Td>
                    <Td className="text-muted">{time(x.createdAt)}</Td>
                  </tr>
                ))}
              </Table>
            )
          }
        </Async>
      </Card>
    </>
  );
}
