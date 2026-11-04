import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Async, Badge, Button, Card, Empty, PageHeader, useConfirm } from "../components/ui";
import { api } from "../lib/api";
import { ago, dateTime, titleCase } from "../lib/format";

interface Applicant {
  id: string; name: string; phone: string; submittedAt: string; verificationStatus: string; licenceNumber: string | null; licenceExpiresAt: string | null; address: string | null;
  vehicles: { id: string; label: string; plate: string; category: string; minYear: number | null; year: number; status: string; rejectionReason: string | null }[];
  history: { at: string; to: string; notes: string | null; by: string | null }[];
}

export function Verification() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ["verification"], queryFn: () => api.get<Applicant[]>("/v1/admin/verification"), refetchInterval: 30_000 });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["verification"] });
    qc.invalidateQueries({ queryKey: ["attention"] });
    qc.invalidateQueries({ queryKey: ["drivers"] });
  };

  return (
    <>
      <PageHeader title="Driver verification" subtitle="Check documents in person at the driver hub, then approve the driver and each vehicle here. Drivers can't take paid rides until both are approved." />
      <Async q={q} loading="Loading the queue…">
        {(list) =>
          list.length === 0 ? (
            <Card><Empty title="Queue is clear" body="New driver registrations and added vehicles appear here." /></Card>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] items-start gap-4">
              {list.map((a) => {
                const licenceExpired = a.licenceExpiresAt ? new Date(a.licenceExpiresAt) < new Date() : false;
                const driverPending = a.verificationStatus !== "APPROVED";
                const approvedVehicle = a.vehicles.some((v) => v.status === "APPROVED");
                return (
                  <Card key={a.id}>
                    <div className="flex flex-col gap-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h2 className="text-base font-bold">{a.name}</h2>
                          <p className="text-[13px] text-muted">{a.phone} · registered {ago(a.submittedAt)}</p>
                        </div>
                        <Badge tone={a.verificationStatus === "APPROVED" ? "green" : a.verificationStatus === "REJECTED" ? "red" : "amber"}>{titleCase(a.verificationStatus)}</Badge>
                      </div>

                      <div className="rounded-[10px] bg-[#f8f9f6] p-3 text-sm">
                        <p className="text-xs font-bold tracking-wide text-muted uppercase">Driver's licence</p>
                        <p className="font-semibold">{a.licenceNumber ?? "Not provided"}</p>
                        <p className={`text-xs ${licenceExpired ? "font-semibold text-bad" : "text-muted"}`}>{a.licenceExpiresAt ? `${licenceExpired ? "Expired" : "Expires"} ${new Date(a.licenceExpiresAt).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}` : "No expiry date"} · {a.address ?? "no address"}</p>
                        <p className="mt-1.5 text-xs text-muted">Photo uploads arrive with the document storage update. Until then, see the original licence in person.</p>
                      </div>

                      {a.vehicles.length === 0 ? <p className="text-sm text-muted">No vehicle added yet.</p> : null}
                      {a.vehicles.map((v) => {
                        const tooOld = v.minYear !== null && v.year < v.minYear;
                        return (
                          <div key={v.id} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-[#f8f9f6] p-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold">{v.label}</p>
                              <p className="text-xs text-muted">{v.plate} · {v.category}{tooOld ? <span className="font-semibold text-bad"> · older than {v.minYear}</span> : null}</p>
                              {v.rejectionReason ? <p className="text-xs text-bad">Rejected: {v.rejectionReason}</p> : null}
                            </div>
                            {v.status === "PENDING_REVIEW" ? (
                              <div className="flex gap-1.5">
                                <Button size="sm" kind="danger" onClick={() => confirm({ title: `Reject ${v.plate}?`, body: "The driver sees the reason in their app and can add another vehicle.", reason: true, danger: true, confirmLabel: "Reject vehicle", success: `${v.plate} rejected.`, run: async (reason) => { await api.post(`/v1/admin/vehicles/${v.id}/reject`, { reason }); refresh(); } })}>Reject</Button>
                                <Button size="sm" kind="primary" onClick={() => confirm({ title: `Approve ${v.plate}?`, body: `Confirm you've seen the registration, insurance and roadworthiness papers for this ${v.label}.`, confirmLabel: "Approve vehicle", success: `${v.plate} approved.`, run: async () => { await api.post(`/v1/admin/vehicles/${v.id}/approve`); refresh(); } })}>Approve</Button>
                              </div>
                            ) : <Badge tone={v.status === "APPROVED" ? "green" : v.status === "REJECTED" ? "red" : "neutral"}>{titleCase(v.status)}</Badge>}
                          </div>
                        );
                      })}

                      {a.history.length ? (
                        <details className="text-xs text-muted">
                          <summary className="cursor-pointer font-semibold">Review history</summary>
                          <ul className="mt-1.5 flex flex-col gap-1">{a.history.map((h, i) => <li key={i}>{dateTime(h.at)} · {titleCase(h.to)}{h.by ? ` by ${h.by}` : ""}{h.notes ? ` · ${h.notes}` : ""}</li>)}</ul>
                        </details>
                      ) : null}

                      {driverPending ? (
                        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3">
                          <span className="text-xs text-muted">{approvedVehicle ? "Vehicle approved. Approve the driver to let them go online." : "Approve a vehicle as well before they can go online."}</span>
                          <div className="flex gap-1.5">
                            <Button size="sm" kind="danger" onClick={() => confirm({ title: `Reject ${a.name}?`, body: "They're told their registration needs changes and can't go online.", reason: true, danger: true, confirmLabel: "Reject driver", success: `${a.name} rejected.`, run: async (reason) => { await api.post(`/v1/admin/drivers/${a.id}/reject`, { reason }); refresh(); } })}>Reject driver</Button>
                            <Button size="sm" kind="primary" disabled={licenceExpired} onClick={() => confirm({ title: `Approve ${a.name}?`, body: "Confirm you've checked their licence, ID and guarantor in person.", confirmLabel: "Approve driver", success: `${a.name} approved.`, run: async () => { await api.post(`/v1/admin/drivers/${a.id}/approve`); refresh(); } })}>Approve driver</Button>
                          </div>
                        </div>
                      ) : null}
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
