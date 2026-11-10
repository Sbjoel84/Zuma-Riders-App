import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { FileText, ImageOff } from "lucide-react";
import { useState } from "react";
import { Async, Badge, Button, Card, Dialog, Empty, PageHeader, useConfirm, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { ago, dateTime, titleCase } from "../lib/format";

interface DocRow {
  kind: "driver" | "vehicle"; type: string; label: string; id: string | null; status: string; documentNumber: string | null; expiresAt: string | null;
  rejectionReason: string | null; uploadedAt: string | null; reviewedBy: string | null; mimeType: string | null; url: string | null;
}
interface DocSet {
  required: boolean;
  driver: DocRow[];
  vehicles: { vehicleId: string; label: string; plateNumber: string; status: string; documents: DocRow[] }[];
}

const DOC_TONE: Record<string, Tone> = { APPROVED: "green", PENDING: "amber", REJECTED: "red", EXPIRED: "red", MISSING: "neutral" };
const DOC_LABEL: Record<string, string> = { APPROVED: "Approved", PENDING: "To review", REJECTED: "Rejected", EXPIRED: "Expired", MISSING: "Not uploaded" };

function DocTile({ d, onChanged }: { d: DocRow; onChanged: () => void }) {
  const confirm = useConfirm();
  const isPdf = d.mimeType === "application/pdf";
  return (
    <div className={clsx("flex flex-col overflow-hidden rounded-[12px] border bg-white", d.status === "PENDING" ? "border-amber" : "border-line-soft")}>
      {d.url ? (
        <a href={d.url} target="_blank" rel="noreferrer" className="relative block aspect-[4/3] overflow-hidden bg-[#eef0eb]" title="Open full size">
          {isPdf ? <span className="flex h-full items-center justify-center gap-2 text-sm font-semibold text-muted"><FileText className="size-5" />Open PDF</span> : <img src={d.url} alt={d.label} className="absolute inset-0 h-full w-full object-contain" loading="lazy" />}
        </a>
      ) : (
        <div className="flex aspect-[4/3] items-center justify-center gap-2 bg-[#f4f5f1] text-xs text-muted"><ImageOff className="size-4" />Not uploaded</div>
      )}
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm leading-tight font-semibold">{d.label}</p>
          <Badge tone={DOC_TONE[d.status]}>{DOC_LABEL[d.status] ?? titleCase(d.status)}</Badge>
        </div>
        <p className="text-xs text-muted">
          {[d.documentNumber, d.expiresAt ? `expires ${new Date(d.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : null, d.uploadedAt ? `uploaded ${ago(d.uploadedAt)}` : null].filter(Boolean).join(" · ") || "\u00a0"}
        </p>
        {d.rejectionReason ? <p className="text-xs text-bad">{d.rejectionReason}</p> : null}
        {d.reviewedBy && d.status !== "PENDING" ? <p className="text-xs text-muted">Reviewed by {d.reviewedBy}</p> : null}
        {d.id && d.status !== "MISSING" ? (
          <div className="mt-auto flex gap-1.5 pt-1">
            {d.status !== "REJECTED" ? (
              <Button size="sm" kind="danger" className="flex-1" onClick={() => confirm({ title: `Reject ${d.label.toLowerCase()}?`, body: "The driver gets a notification with your reason and can upload a new one.", reason: true, reasonLabel: "What should the driver fix?", danger: true, confirmLabel: "Reject document", success: `${d.label} rejected.`, run: async (reason) => { await api.post(`/v1/admin/documents/${d.kind}/${d.id}/reject`, { reason }); onChanged(); } })}>Reject</Button>
            ) : null}
            {d.status !== "APPROVED" ? (
              <Button size="sm" kind="primary" className="flex-1" onClick={() => confirm({ title: `Approve ${d.label.toLowerCase()}?`, body: "Check the photo is clear, the name matches the driver, and the details are in date.", confirmLabel: "Approve", success: `${d.label} approved.`, run: async () => { await api.post(`/v1/admin/documents/${d.kind}/${d.id}/approve`); onChanged(); } })}>Approve</Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DocumentsDialog({ driverId, name, open, onClose, onChanged }: { driverId: string; name: string; open: boolean; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["documents", driverId], queryFn: () => api.get<DocSet>(`/v1/admin/drivers/${driverId}/documents`), enabled: open });
  const changed = () => {
    qc.invalidateQueries({ queryKey: ["documents", driverId] });
    onChanged();
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Documents · ${name}`} wide footer={<Button onClick={onClose}>Done</Button>}>
      <Async q={q} loading="Loading documents…">
        {(d) => (
          <div className="flex flex-col gap-5">
            <p className="text-muted">Click a photo to open it full size. Links expire after 10 minutes; reopen this window to refresh them.</p>
            <section className="flex flex-col gap-2">
              <h3 className="font-bold">Driver</h3>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">{d.driver.map((x) => <DocTile key={x.type} d={x} onChanged={changed} />)}</div>
            </section>
            {d.vehicles.map((v) => (
              <section key={v.vehicleId} className="flex flex-col gap-2">
                <h3 className="font-bold">{v.label} · {v.plateNumber} <span className="ml-1 align-middle"><Badge tone={v.status === "APPROVED" ? "green" : v.status === "REJECTED" ? "red" : "amber"}>{titleCase(v.status)}</Badge></span></h3>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">{v.documents.map((x) => <DocTile key={x.type} d={x} onChanged={changed} />)}</div>
              </section>
            ))}
          </div>
        )}
      </Async>
    </Dialog>
  );
}

interface Applicant {
  id: string; name: string; phone: string; submittedAt: string; verificationStatus: string; licenceNumber: string | null; licenceExpiresAt: string | null; address: string | null;
  documents: { uploaded: number; approved: number; pending: number; rejected: number; required: number };
  vehicles: { id: string; label: string; plate: string; category: string; minYear: number | null; year: number; status: string; rejectionReason: string | null }[];
  history: { at: string; to: string; notes: string | null; by: string | null }[];
}

export function Verification() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [docsFor, setDocsFor] = useState<{ id: string; name: string } | null>(null);
  const q = useQuery({ queryKey: ["verification"], queryFn: () => api.get<Applicant[]>("/v1/admin/verification"), refetchInterval: 30_000 });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["verification"] });
    qc.invalidateQueries({ queryKey: ["attention"] });
    qc.invalidateQueries({ queryKey: ["drivers"] });
  };

  return (
    <>
      <PageHeader title="Driver verification" subtitle="Review each uploaded document, then approve the driver and each vehicle. Drivers can't go online until both are approved." />
      {docsFor ? <DocumentsDialog driverId={docsFor.id} name={docsFor.name} open onClose={() => setDocsFor(null)} onChanged={refresh} /> : null}
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
                      </div>

                      <button onClick={() => setDocsFor({ id: a.id, name: a.name })} className="flex cursor-pointer items-center gap-3 rounded-[10px] border border-line-soft p-3 text-left hover:border-ink">
                        <FileText className="size-5 flex-none text-muted" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold">Documents · {a.documents.approved} of {a.documents.required} approved</span>
                          <span className="block text-xs text-muted">
                            {a.documents.uploaded < a.documents.required ? `${a.documents.required - a.documents.uploaded} not uploaded yet` : "All uploaded"}
                            {a.documents.pending ? ` · ${a.documents.pending} to review` : ""}{a.documents.rejected ? ` · ${a.documents.rejected} rejected` : ""}
                          </span>
                        </span>
                        <span className="text-xs font-semibold">Review</span>
                      </button>

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
                                <Button size="sm" kind="primary" onClick={() => confirm({ title: `Approve ${v.plate}?`, body: `Its vehicle licence, roadworthiness, insurance and photos must all be approved first.`, confirmLabel: "Approve vehicle", success: `${v.plate} approved.`, run: async () => { await api.post(`/v1/admin/vehicles/${v.id}/approve`); refresh(); } })}>Approve</Button>
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
                            <Button size="sm" kind="primary" disabled={licenceExpired} onClick={() => confirm({ title: `Approve ${a.name}?`, body: "Their licence, ID and profile photo must all be approved first.", confirmLabel: "Approve driver", success: `${a.name} approved.`, run: async () => { await api.post(`/v1/admin/drivers/${a.id}/approve`); refresh(); } })}>Approve driver</Button>
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
