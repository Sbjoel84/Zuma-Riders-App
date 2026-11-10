import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer } from "react-leaflet";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Async, Badge, Button, Card, Chips, Empty, Input, PageHeader, Table, Td, useConfirm } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dateTime, km, naira, time, titleCase } from "../lib/format";
import { NEGOTIATION_ACTION, RIDE_STATUS } from "../lib/status";

interface RideRow { id: string; code: string; status: string; passenger: string; driver: string; pickup: string; dropoff: string; proposedFare: string; agreedFare: string; finalFare: string | null; commission: string | null; paymentMethod: string; createdAt: string }
interface RidesPage { counts: Record<string, number>; data: RideRow[]; nextCursor: string | null }

export function Rides() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const group = params.get("group") ?? "all";
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [q, setQ] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const list = useInfiniteQuery({
    queryKey: ["rides", group, q],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<RidesPage>(`/v1/admin/rides?limit=30${group !== "all" ? `&group=${group}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
  const counts = list.data?.pages[0]?.counts;
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader title="Rides" subtitle="Every trip with its negotiation, status history and money" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Chips
          label="Ride status"
          value={group}
          onChange={(v) => setParams((p) => { if (v === "all") p.delete("group"); else p.set("group", v); return p; })}
          options={[
            { value: "all", label: "All", count: counts?.all },
            { value: "active", label: "Active", count: counts?.active },
            { value: "completed", label: "Completed", count: counts?.completed },
            { value: "cancelled", label: "Cancelled", count: counts?.cancelled },
            { value: "disputed", label: "Disputed", count: counts?.disputed },
          ]}
        />
        <label className="flex items-center gap-2 text-sm text-muted">
          Search
          <Input className="w-64" placeholder="Code, name, phone or plate" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>

      <div className="grid items-start gap-4 2xl:grid-cols-[3fr_2fr]">
        <Card pad={false}>
          <Async q={{ ...list, data: list.data }}>
            {() =>
              rows.length === 0 ? (
                <Empty title={q ? `No rides match "${q}"` : "No rides in this view"} />
              ) : (
                <>
                  <Table head={["Ride", "Route", "Passenger · Driver", "Agreed", "Pay", "Status", "When"]} minWidth={820}>
                    {rows.map((r) => (
                      <tr key={r.id} className={r.id === id ? "bg-[#fff9e8]" : undefined}>
                        <Td><Link to={`/rides/${r.id}${params.toString() ? `?${params}` : ""}`} className="font-bold underline">{r.code}</Link></Td>
                        <Td className="max-w-[240px] truncate text-[#3d443c]">{r.pickup.split(",")[0]} → {r.dropoff.split(",")[0]}</Td>
                        <Td>{r.passenger} · {r.driver}</Td>
                        <Td className="tabular">{naira(r.finalFare ?? r.agreedFare)}</Td>
                        <Td>{titleCase(r.paymentMethod)}</Td>
                        <Td><Badge tone={RIDE_STATUS[r.status]?.tone}>{RIDE_STATUS[r.status]?.label ?? r.status}</Badge></Td>
                        <Td className="text-muted">{dateTime(r.createdAt)}</Td>
                      </tr>
                    ))}
                  </Table>
                  {list.hasNextPage ? <div className="p-3 text-center"><Button onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>Load more</Button></div> : null}
                </>
              )
            }
          </Async>
        </Card>
        {id ? <RideDetail id={id} /> : <Card><Empty title="Select a ride" body="Open a ride to see the full negotiation, status history, route and ledger entries." /></Card>}
      </div>
    </>
  );
}

interface RideDetailData {
  id: string; code: string; status: string; category: string;
  passenger: { name: string; phone: string; rating: string }; driver: { id: string; name: string; phone: string; rating: string };
  vehicle: { label: string; plate: string };
  pickup: { address: string; lat: number; lng: number }; dropoff: { address: string; lat: number; lng: number };
  distanceM: number; durationS: number; suggestedFare: string; proposedFare: string; agreedFare: string; finalFare: string | null; commission: string | null; commissionBps: number;
  paymentMethod: string; pinAttempts: number;
  discount: string; promoCode: string | null;
  payments: { reference: string; method: string; status: string; amount: string; fee: string; card: string | null; failureReason: string | null }[];
  chat: { id: string; from: string; body: string | null; imageUrl: string | null; flagged: boolean; at: string }[];
  times: Record<string, string | null>;
  cancellation: { by: string; reason: string; text: string | null; fee: string } | null;
  ratings: { by: string; stars: number; comment: string | null }[];
  negotiation: { at: string; actor: string; who: string | null; action: string; amount: string | null; previous: string | null }[];
  statusHistory: { at: string; from: string | null; to: string; actor: string; reason: string | null }[];
  breadcrumbs: { lat: number; lng: number }[];
  ledger: { id: string; type: string; description: string; entries: { account: string; direction: string; amount: string }[] }[];
}

function RideDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const confirm = useConfirm();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["ride", id], queryFn: () => api.get<RideDetailData>(`/v1/admin/rides/${id}`), refetchInterval: 10_000 });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ride", id] });
    qc.invalidateQueries({ queryKey: ["rides"] });
    qc.invalidateQueries({ queryKey: ["attention"] });
  };

  return (
    <Card className="2xl:sticky 2xl:top-4">
      <Async q={q}>
        {(r) => {
          const active = ["DRIVER_SELECTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED"].includes(r.status);
          const disputable = ["TRIP_STARTED", "TRIP_COMPLETED"].includes(r.status);
          const line: [number, number][] = r.breadcrumbs.length > 1 ? r.breadcrumbs.map((b) => [b.lat, b.lng]) : [[r.pickup.lat, r.pickup.lng], [r.dropoff.lat, r.dropoff.lng]];
          return (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-xl font-bold">{r.code}</h2>
                <div className="flex items-center gap-2">
                  <Badge tone={RIDE_STATUS[r.status]?.tone}>{RIDE_STATUS[r.status]?.label ?? r.status}</Badge>
                  <Button size="sm" kind="ghost" onClick={() => nav("/rides")}>Close</Button>
                </div>
              </div>

              <div className="h-[180px] overflow-hidden rounded-[10px]">
                <MapContainer key={r.id} bounds={line} boundsOptions={{ padding: [24, 24] }} className="h-full w-full" scrollWheelZoom={false}>
                  <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  <Polyline positions={line} pathOptions={{ color: "#12161b", weight: 3, dashArray: r.breadcrumbs.length > 1 ? undefined : "6 6" }} />
                  <CircleMarker center={[r.pickup.lat, r.pickup.lng]} radius={7} pathOptions={{ color: "#fff", weight: 2, fillColor: "#12161b", fillOpacity: 1 }} />
                  <CircleMarker center={[r.dropoff.lat, r.dropoff.lng]} radius={7} pathOptions={{ color: "#12161b", weight: 2, fillColor: "#f2a900", fillOpacity: 1 }} />
                </MapContainer>
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                <Info k="Passenger" v={`${r.passenger.name} · ★ ${r.passenger.rating}`} sub={r.passenger.phone} />
                <Info k="Driver" v={`${r.driver.name} · ★ ${r.driver.rating}`} sub={r.driver.phone} />
                <Info k="Vehicle" v={r.vehicle.label} sub={`${r.vehicle.plate} · ${r.category}`} />
                <Info k="Route" v={km(r.distanceM)} sub={`${Math.round(r.durationS / 60)} min estimated`} />
                <Info k="From" v={r.pickup.address} />
                <Info k="To" v={r.dropoff.address} />
                <Info k="Fare" v={`${naira(r.proposedFare)} proposed → ${naira(r.agreedFare)} agreed`} sub={`Suggested ${naira(r.suggestedFare)}${r.finalFare ? ` · final ${naira(r.finalFare)}` : ""}`} />
                <Info k="Payment" v={`${titleCase(r.paymentMethod)}${r.payments.find((p) => p.card && p.status === "SUCCEEDED") ? ` · ${r.payments.find((p) => p.card && p.status === "SUCCEEDED")!.card}` : ""}`} sub={r.commission ? `Commission ${naira(r.commission)} (${r.commissionBps / 100}%)` : `Commission rate ${r.commissionBps / 100}%`} />
                {BigInt(r.discount) > 0n ? <Info k="Promo" v={`${r.promoCode ?? "Promo"} · ${naira(r.discount)} off`} sub="Paid by Zuma. The driver earns on the full agreed fare." /> : null}
              </dl>

              {r.payments.some((p) => p.status === "FAILED") ? (
                <p className="rounded-[10px] bg-amber-soft px-3 py-2 text-sm text-amber-text">
                  Card charge failed{r.payments.find((p) => p.status === "FAILED")?.failureReason ? ` (${r.payments.find((p) => p.status === "FAILED")!.failureReason})` : ""}. The trip was settled {r.paymentMethod === "WALLET" ? "from the wallet" : "in cash"}.
                </p>
              ) : null}

              {r.cancellation ? (
                <p className="rounded-[10px] bg-bad-soft px-3 py-2 text-sm text-bad-text">
                  Cancelled by {r.cancellation.by.toLowerCase()} · {titleCase(r.cancellation.reason)}{r.cancellation.text ? ` · ${r.cancellation.text}` : ""}{BigInt(r.cancellation.fee) > 0n ? ` · fee ${naira(r.cancellation.fee)}` : ""}
                </p>
              ) : null}

              <section>
                <h3 className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Negotiation</h3>
                <ol className="flex flex-col gap-1.5 text-sm">
                  {r.negotiation.map((e, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="tabular w-12 flex-none text-muted">{time(e.at)}</span>
                      <span>
                        <b>{e.who ?? titleCase(e.actor)}</b> {NEGOTIATION_ACTION[e.action] ?? titleCase(e.action)} {e.amount && !["DRIVER_ACCEPTED_PRICE"].includes(e.action) ? <b className="tabular">{naira(e.amount)}</b> : null}
                        {e.action === "DRIVER_ACCEPTED_PRICE" && e.amount ? <> of <b className="tabular">{naira(e.amount)}</b></> : null}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Status history</h3>
                <ol className="flex flex-col gap-1.5 text-sm">
                  {r.statusHistory.map((h, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="tabular w-12 flex-none text-muted">{time(h.at)}</span>
                      <span>{RIDE_STATUS[h.to]?.label ?? h.to} <span className="text-muted">· by {h.actor.toLowerCase()}{h.reason ? ` · ${titleCase(h.reason)}` : ""}</span></span>
                    </li>
                  ))}
                </ol>
              </section>

              {r.chat.length ? (
                <section>
                  <h3 className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Chat ({r.chat.length})</h3>
                  <ol className="flex flex-col gap-1.5">
                    {r.chat.map((m) => (
                      <li key={m.id} className={`max-w-[85%] rounded-[12px] px-3 py-2 text-sm ${m.from === "PASSENGER" ? "self-start bg-[#f1f3ee]" : "self-end bg-ink text-white"}`}>
                        <span className={`block text-[11px] ${m.from === "PASSENGER" ? "text-muted" : "text-[#c9cec7]"}`}>{m.from === "PASSENGER" ? r.passenger.name.split(" ")[0] : r.driver.name.split(" ")[0]} · {time(m.at)}{m.flagged ? " · contains a phone number" : ""}</span>
                        {m.imageUrl ? <a href={m.imageUrl} target="_blank" rel="noreferrer" className="underline">Photo</a> : m.body}
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}

              {r.ratings.length ? (
                <section>
                  <h3 className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Ratings</h3>
                  {r.ratings.map((x, i) => <p key={i} className="text-sm">{x.by === "PASSENGER" ? "Passenger rated driver" : "Driver rated passenger"} {"★".repeat(x.stars)}{x.comment ? ` · "${x.comment}"` : ""}</p>)}
                </section>
              ) : null}

              {r.ledger.length ? (
                <section>
                  <h3 className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Ledger</h3>
                  {r.ledger.map((t) => (
                    <div key={t.id} className="mb-2 rounded-[10px] bg-[#f8f9f6] p-2.5 text-xs">
                      <p className="mb-1 font-semibold">{t.description}</p>
                      {t.entries.map((e, i) => (
                        <p key={i} className="tabular flex justify-between gap-3 font-mono">
                          <span className="truncate">{e.direction === "DEBIT" ? "DR" : "CR"} {e.account}</span>
                          <span>{naira(e.amount)}</span>
                        </p>
                      ))}
                    </div>
                  ))}
                </section>
              ) : null}

              {can("rides:write") && (active || disputable) ? (
                <div className="flex flex-wrap gap-2 border-t border-line-soft pt-3">
                  {disputable ? (
                    <Button onClick={() => confirm({ title: `Flag ${r.code} as disputed?`, body: "Driver earnings from this trip stay on hold until the dispute is resolved.", reason: true, confirmLabel: "Flag dispute", success: `${r.code} flagged as disputed.`, run: async (reason) => { await api.post(`/v1/admin/rides/${r.id}/dispute`, { reason }); refresh(); } })}>Flag dispute</Button>
                  ) : null}
                  {active ? (
                    <Button kind="danger" onClick={() => confirm({ title: `Cancel ${r.code}?`, body: `Both ${r.passenger.name} and ${r.driver.name} are told the trip was cancelled, and the driver becomes available again. No cancellation fee is charged.`, reason: true, danger: true, confirmLabel: "Cancel ride", success: `${r.code} cancelled.`, run: async (reason) => { await api.post(`/v1/admin/rides/${r.id}/cancel`, { reason }); refresh(); } })}>Cancel ride</Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        }}
      </Async>
    </Card>
  );
}

function Info({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="font-semibold break-words">{v}</dd>
      {sub ? <dd className="text-xs text-muted">{sub}</dd> : null}
    </div>
  );
}
