import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { useState } from "react";
import { CircleMarker, MapContainer, TileLayer } from "react-leaflet";
import { Link } from "react-router";
import { Async, Badge, Button, Card, Chips, Empty, PageHeader, useConfirm } from "../components/ui";
import { api } from "../lib/api";
import { ago, dateTime, titleCase } from "../lib/format";
import { INCIDENT_STATUS } from "../lib/status";

interface Incident {
  id: string; type: string; status: string; reporter: string; reporterPhone: string; reporterRole: string; lat: number | null; lng: number | null; description: string | null; createdAt: string;
  ride: { id: string; code: string; status: string; passenger: string; passengerPhone: string; driver: string; driverPhone: string; vehicle: string; route: string } | null;
  handler: string | null; acknowledgedAt: string | null; externalEscalatedAt: string | null; externalEscalationNote: string | null; resolvedAt: string | null;
  timeline: { at: string; actor: string; event: string }[];
}

export function Safety() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [filter, setFilter] = useState("open");
  const q = useQuery({ queryKey: ["incidents", filter], queryFn: () => api.get<Incident[]>(`/v1/admin/safety/incidents${filter === "open" ? "?status=open" : ""}`), refetchInterval: 5_000 });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["incidents"] });
    qc.invalidateQueries({ queryKey: ["attention"] });
  };

  return (
    <>
      <PageHeader title="Safety" subtitle="SOS alerts and safety reports. This page refreshes every 5 seconds." actions={<Chips label="Incidents" value={filter} onChange={setFilter} options={[{ value: "open", label: "Open" }, { value: "all", label: "All, last 100" }]} />} />
      <p className="rounded-[12px] bg-amber-soft px-4 py-3 text-sm text-amber-text">
        Riders App does not contact police or ambulance automatically. When a rider presses SOS, their app shows 112 and 199 to call. Riders are told emergency services were contacted only after you record it here.
      </p>
      <Async q={q} loading="Loading incidents…">
        {(list) =>
          list.length === 0 ? (
            <Card><Empty title={filter === "open" ? "No open incidents" : "No incidents recorded"} body="SOS presses and safety reports from the apps appear here immediately." /></Card>
          ) : (
            <div className="flex flex-col gap-4">
              {list.map((i) => {
                const open = ["TRIGGERED", "ACKNOWLEDGED", "ESCALATED_EXTERNAL"].includes(i.status);
                return (
                  <Card key={i.id} className={clsx(i.status === "TRIGGERED" && "border-2 border-bad")}>
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className={clsx("text-xs font-bold tracking-wider uppercase", i.type === "SOS" ? "text-bad" : "text-amber-text")}>{i.type === "SOS" ? "SOS" : titleCase(i.type)} · {i.reporterRole.toLowerCase()} · {ago(i.createdAt)}</p>
                          <h2 className="font-display text-lg font-bold">{i.reporter} · <a href={`tel:${i.reporterPhone}`} className="underline">{i.reporterPhone}</a></h2>
                          {i.ride ? (
                            <p className="text-sm text-muted"><Link to={`/rides/${i.ride.id}`} className="font-semibold underline">{i.ride.code}</Link> · {i.ride.route}<br />Driver {i.ride.driver} ({i.ride.driverPhone}) · {i.ride.vehicle} · passenger {i.ride.passenger} ({i.ride.passengerPhone})</p>
                          ) : <p className="text-sm text-muted">Not linked to a trip</p>}
                          {i.description ? <p className="mt-1 text-sm">"{i.description}"</p> : null}
                        </div>
                        <Badge tone={INCIDENT_STATUS[i.status]?.tone}>{INCIDENT_STATUS[i.status]?.label ?? i.status}</Badge>
                      </div>
                      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr]">
                        {i.lat !== null && i.lng !== null ? (
                          <div className="h-[180px] overflow-hidden rounded-[10px]">
                            <MapContainer center={[i.lat, i.lng]} zoom={15} className="h-full w-full" scrollWheelZoom={false}>
                              <TileLayer attribution='&copy; OpenStreetMap' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                              <CircleMarker center={[i.lat, i.lng]} radius={10} pathOptions={{ color: "#fff", weight: 3, fillColor: "#b3261e", fillOpacity: 1 }} />
                            </MapContainer>
                          </div>
                        ) : <div className="flex items-center justify-center rounded-[10px] bg-ground text-sm text-muted">No location</div>}
                        <div>
                          <h3 className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Timeline</h3>
                          <ol className="flex flex-col gap-1.5 text-sm">
                            {i.timeline.map((e, n) => <li key={n} className="flex gap-3"><span className="tabular w-[92px] flex-none text-muted">{dateTime(e.at)}</span><span>{e.event}</span></li>)}
                          </ol>
                        </div>
                        <div className="flex flex-col gap-2">
                          <h3 className="text-xs font-bold tracking-wide text-muted uppercase">Actions</h3>
                          {i.status === "TRIGGERED" ? <Button kind="danger" className="!bg-bad !text-white" onClick={() => confirm({ title: "Acknowledge and call now", body: `Call ${i.reporter} on ${i.reporterPhone} straight after acknowledging.`, confirmLabel: "Acknowledge", success: "Acknowledged. Call the rider now.", run: async () => { await api.post(`/v1/admin/safety/incidents/${i.id}/acknowledge`); refresh(); } })}>Acknowledge and call</Button> : null}
                          {i.status === "ACKNOWLEDGED" ? <Button onClick={() => confirm({ title: "Record contact with emergency services", body: "Only record this after you have actually spoken to police, ambulance or fire service. The rider's app will then say emergency services were contacted.", reason: true, reasonLabel: "Who you contacted and any reference number", confirmLabel: "Record contact", success: "Contact with emergency services recorded.", run: async (note) => { await api.post(`/v1/admin/safety/incidents/${i.id}/escalation`, { note }); refresh(); } })}>Record that I contacted emergency services</Button> : null}
                          {i.status === "ACKNOWLEDGED" || i.status === "ESCALATED_EXTERNAL" ? <Button kind="primary" onClick={() => confirm({ title: "Resolve incident", reason: true, reasonLabel: "Outcome", confirmLabel: "Resolve", success: "Incident resolved.", run: async (note) => { await api.post(`/v1/admin/safety/incidents/${i.id}/resolve`, { note }); refresh(); } })}>Resolve</Button> : null}
                          {i.status === "TRIGGERED" || i.status === "ACKNOWLEDGED" ? <Button kind="ghost" onClick={() => confirm({ title: "Mark as false alarm?", reason: true, reasonLabel: "How you confirmed it", confirmLabel: "Mark false alarm", success: "Marked as a false alarm.", run: async (note) => { await api.post(`/v1/admin/safety/incidents/${i.id}/false-alarm`, { note }); refresh(); } })}>False alarm</Button> : null}
                          {!open ? <p className="text-sm text-muted">Closed {ago(i.resolvedAt)}{i.handler ? ` by ${i.handler}` : ""}.</p> : null}
                          {i.externalEscalationNote ? <p className="text-xs text-muted">Emergency contact: {i.externalEscalationNote}</p> : null}
                        </div>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )
        }
      </Async>
    </>
  );
}
