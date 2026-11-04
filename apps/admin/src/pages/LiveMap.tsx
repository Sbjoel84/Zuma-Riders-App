import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from "react-leaflet";
import { Link } from "react-router";
import { Async, Badge, Card, Chips, Empty, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { ago, naira } from "../lib/format";
import { RIDE_STATUS } from "../lib/status";

interface Snapshot {
  drivers: { driverId: string; name: string; status: string; category: string | null; plate: string | null; lat: number; lng: number; lastSeen: string | null; stale: boolean }[];
  rides: { id: string; code: string; status: string; passenger: string; driver: string; driverId: string; pickup: { address: string; lat: number; lng: number }; dropoff: { address: string; lat: number; lng: number }; agreedFare: string; paymentMethod: string }[];
  requests: { id: string; code: string; category: string; lat: number; lng: number; proposedFare: string; offers: number; expiresAt: string }[];
}

const ABUJA: [number, number] = [9.0579, 7.4951];

export function LiveMap() {
  const [cat, setCat] = useState("all");
  const q = useQuery({ queryKey: ["live"], queryFn: () => api.get<Snapshot>("/v1/admin/live/snapshot"), refetchInterval: 5_000 });

  const cats = useMemo(() => {
    const s = new Set((q.data?.drivers ?? []).map((d) => d.category).filter(Boolean) as string[]);
    return [{ value: "all", label: "All", count: q.data?.drivers.length }, ...[...s].map((c) => ({ value: c, label: c[0]!.toUpperCase() + c.slice(1), count: q.data?.drivers.filter((d) => d.category === c).length }))];
  }, [q.data]);

  return (
    <>
      <PageHeader title="Live map" subtitle="Online drivers, open requests and trips in progress. Updates every 5 seconds." />
      <Async q={q} loading="Loading live positions…">
        {(s) => {
          const drivers = s.drivers.filter((d) => cat === "all" || d.category === cat);
          const pos = new Map(s.drivers.map((d) => [d.driverId, d]));
          return (
            <div className="grid gap-4 xl:grid-cols-[3fr_1.3fr]">
              <Card pad={false} className="overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <Chips label="Vehicle category" value={cat} onChange={setCat} options={cats} />
                  <div className="flex flex-wrap gap-3 text-xs text-muted">
                    <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-ok" />Free</span>
                    <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border border-ink bg-amber" />On trip</span>
                    <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-info" />Open request</span>
                    <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-[#9aa39a]" />Signal lost</span>
                  </div>
                </div>
                <div className="h-[560px] max-w-full">
                  <MapContainer center={ABUJA} zoom={12} scrollWheelZoom className="h-full w-full">
                    <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                    {s.rides.map((r) => {
                      const d = pos.get(r.driverId);
                      const target = r.status === "TRIP_STARTED" ? r.dropoff : r.pickup;
                      return d ? <Polyline key={r.id} positions={[[d.lat, d.lng], [target.lat, target.lng]]} pathOptions={{ color: "#12161b", weight: 2, dashArray: "6 6" }} /> : null;
                    })}
                    {s.requests.map((r) => (
                      <CircleMarker key={r.id} center={[r.lat, r.lng]} radius={8} pathOptions={{ color: "#fff", weight: 2, fillColor: "#1d4f8a", fillOpacity: 1 }}>
                        <Tooltip>{r.code} · {r.category} · offers {naira(r.proposedFare)} · {r.offers} driver offer(s)</Tooltip>
                      </CircleMarker>
                    ))}
                    {drivers.map((d) => (
                      <CircleMarker key={d.driverId} center={[d.lat, d.lng]} radius={7} pathOptions={{ color: "#12161b", weight: d.status === "ON_TRIP" ? 2 : 1, fillColor: d.stale ? "#9aa39a" : d.status === "ON_TRIP" ? "#f2a900" : "#1f7a4f", fillOpacity: 1 }}>
                        <Tooltip>{d.name} · {d.plate ?? "no vehicle"} · {d.status === "ON_TRIP" ? "on trip" : "free"} · seen {ago(d.lastSeen)}</Tooltip>
                      </CircleMarker>
                    ))}
                  </MapContainer>
                </div>
                <p className="px-4 py-2.5 text-xs text-muted">{drivers.length} driver(s) shown · {s.requests.length} open request(s) · {s.rides.length} active trip(s)</p>
              </Card>

              <Card title="Active trips">
                {s.rides.length === 0 ? (
                  <Empty title="No trips in progress" />
                ) : (
                  <ul className="flex flex-col gap-2">
                    {s.rides.map((r) => (
                      <li key={r.id}>
                        <Link to={`/rides/${r.id}`} className="flex items-center justify-between gap-3 rounded-[10px] border border-line-soft px-3 py-2.5 hover:border-ink">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-bold">{r.code} · {r.pickup.address.split(",")[0]} → {r.dropoff.address.split(",")[0]}</span>
                            <span className="block text-xs text-muted">{r.driver} with {r.passenger} · {naira(r.agreedFare)} {r.paymentMethod.toLowerCase()}</span>
                          </span>
                          <Badge tone={RIDE_STATUS[r.status]?.tone}>{RIDE_STATUS[r.status]?.label}</Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          );
        }}
      </Async>
    </>
  );
}
