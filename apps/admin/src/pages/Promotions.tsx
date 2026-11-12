import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { Async, Badge, Button, Card, Chips, Dialog, Empty, Field, Input, Kpi, PageHeader, Select, Table, Td, Textarea, useConfirm, useToast, type Tone } from "../components/ui";
import { api, errorText } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dateTime, naira, titleCase, toKobo } from "../lib/format";

interface Code { id: string; code: string; description: string; usageLimit: number | null; usedCount: number; perUserLimit: number; firstRideOnly: boolean; categoryKeys: string[]; minFare: string | null }
interface Promotion { id: string; name: string; description: string | null; isActive: boolean; startsAt: string; endsAt: string; budget: string | null; spent: string; state: string; codes: Code[] }
interface Redemption { id: string; code: string; user: string; phone: string; amount: string; ride: { id: string; code: string } | null; createdAt: string }
interface Referrals {
  rewards: { passenger: string; driver: string; driverTrips: number };
  totalPaid: string;
  data: { id: string; referrer: string; referrerPhone: string; referee: string; refereePhone: string; role: string; status: string; paid: string; createdAt: string; qualifiedAt: string | null }[];
}

const STATE: Record<string, { label: string; tone: Tone }> = {
  LIVE: { label: "Live", tone: "green" }, SCHEDULED: { label: "Scheduled", tone: "blue" }, PAUSED: { label: "Paused", tone: "neutral" },
  ENDED: { label: "Ended", tone: "neutral" }, BUDGET_USED: { label: "Budget used up", tone: "amber" },
};
const REF_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Waiting for first trip", tone: "amber" }, QUALIFIED: { label: "Qualified", tone: "blue" }, REWARDED: { label: "Rewarded", tone: "green" },
  REJECTED_FRAUD: { label: "Rejected: same phone", tone: "red" }, EXPIRED: { label: "Expired", tone: "neutral" },
};

export function Promotions() {
  const [tab, setTab] = useState("promos");
  return (
    <>
      <PageHeader title="Promotions" subtitle="Promo codes and referral rewards. Riders App pays every discount: drivers always earn on the full agreed fare." actions={<Chips label="View" value={tab} onChange={setTab} options={[{ value: "promos", label: "Promo codes" }, { value: "referrals", label: "Referrals" }]} />} />
      {tab === "promos" ? <PromoList /> : <ReferralList />}
    </>
  );
}

function PromoList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [usageOf, setUsageOf] = useState<Promotion | null>(null);
  const q = useQuery({ queryKey: ["promotions"], queryFn: () => api.get<Promotion[]>("/v1/admin/promotions") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["promotions"] });

  return (
    <>
      <div className="flex justify-end"><Button kind="primary" onClick={() => setCreating(true)}>New promo code</Button></div>
      <Async q={q} loading="Loading promotions…">
        {(list) =>
          list.length === 0 ? <Card><Empty title="No promotions yet" body="Create a code like WELCOME50 to give new riders a discount on their first trip." /></Card> : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] items-start gap-4">
              {list.map((p) => {
                const c = p.codes[0];
                const budget = p.budget ? BigInt(p.budget) : null;
                const used = budget ? Number((BigInt(p.spent) * 1000n) / (budget || 1n)) / 10 : null;
                return (
                  <Card key={p.id}>
                    <div className="flex flex-col gap-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-display text-xl font-bold tracking-wide">{c?.code ?? "—"}</p>
                          <p className="text-sm font-semibold">{p.name}</p>
                        </div>
                        <Badge tone={STATE[p.state]?.tone}>{STATE[p.state]?.label ?? p.state}</Badge>
                      </div>
                      {c ? <p className="text-sm">{c.description}</p> : null}
                      <dl className="grid grid-cols-2 gap-2 text-sm">
                        <div><dt className="text-xs text-muted">Used</dt><dd className="tabular font-semibold">{c?.usedCount ?? 0}{c?.usageLimit ? ` of ${c.usageLimit}` : ""}</dd></div>
                        <div><dt className="text-xs text-muted">Discounts paid</dt><dd className="tabular font-semibold">{naira(p.spent)}{budget ? ` of ${naira(p.budget)}` : ""}</dd></div>
                        <div><dt className="text-xs text-muted">Per rider</dt><dd>{c?.perUserLimit ?? 1}×{c?.firstRideOnly ? " · first ride only" : ""}</dd></div>
                        <div><dt className="text-xs text-muted">Runs</dt><dd>{new Date(p.startsAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – {new Date(p.endsAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</dd></div>
                      </dl>
                      {used !== null ? (
                        <div className="h-2 overflow-hidden rounded-full bg-line-soft" role="img" aria-label={`${used}% of budget used`}>
                          <div className="h-full rounded-full bg-amber" style={{ width: `${Math.min(100, used)}%` }} />
                        </div>
                      ) : null}
                      <div className="flex flex-wrap gap-2 border-t border-line-soft pt-3">
                        <Button size="sm" onClick={() => setUsageOf(p)}>See redemptions</Button>
                        {p.isActive ? (
                          <Button size="sm" kind="danger" onClick={() => confirm({ title: `Pause ${c?.code}?`, body: "Riders can't use the code until you resume it. Trips already booked with it keep their discount.", danger: true, confirmLabel: "Pause code", success: `${c?.code} paused.`, run: async () => { await api.post(`/v1/admin/promotions/${p.id}/active`, { isActive: false }); refresh(); } })}>Pause</Button>
                        ) : (
                          <Button size="sm" kind="primary" onClick={() => confirm({ title: `Resume ${c?.code}?`, confirmLabel: "Resume code", success: `${c?.code} is live again.`, run: async () => { await api.post(`/v1/admin/promotions/${p.id}/active`, { isActive: true }); refresh(); } })}>Resume</Button>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )
        }
      </Async>
      {creating ? <CreatePromo onClose={() => setCreating(false)} onCreated={refresh} /> : null}
      {usageOf ? <RedemptionsDialog promo={usageOf} onClose={() => setUsageOf(null)} /> : null}
    </>
  );
}

function RedemptionsDialog({ promo, onClose }: { promo: Promotion; onClose: () => void }) {
  const q = useQuery({ queryKey: ["redemptions", promo.id], queryFn: () => api.get<Redemption[]>(`/v1/admin/promotions/${promo.id}/redemptions`) });
  return (
    <Dialog open onClose={onClose} title={`${promo.codes[0]?.code ?? promo.name} redemptions`} wide footer={<Button onClick={onClose}>Close</Button>}>
      <Async q={q}>
        {(rows) =>
          rows.length === 0 ? <Empty title="Not used yet" body="Redemptions are counted when a trip with the code completes." /> : (
            <Table head={["When", "Rider", "Trip", "Discount"]} minWidth={560}>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="text-muted">{dateTime(r.createdAt)}</Td>
                  <Td><b>{r.user}</b><div className="text-xs text-muted">{r.phone}</div></Td>
                  <Td>{r.ride ? <Link className="underline" to={`/rides/${r.ride.id}`} onClick={onClose}>{r.ride.code}</Link> : "—"}</Td>
                  <Td className="tabular font-semibold">{naira(r.amount)}</Td>
                </tr>
              ))}
            </Table>
          )
        }
      </Async>
    </Dialog>
  );
}

const CATEGORIES = [["economy", "Economy"], ["comfort", "Comfort"], ["premium", "Premium"], ["suv", "SUV"]] as const;

function CreatePromo({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ name: "", description: "", code: "", type: "PERCENTAGE", value: "", maxDiscount: "", minFare: "", usageLimit: "", perUserLimit: "1", firstRideOnly: false, budget: "", startsAt: today, endsAt: in30, categories: [] as string[] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const submit = async () => {
    setErr(null);
    const value = f.type === "PERCENTAGE" ? Number(f.value) : Number(toKobo(f.value) ?? 0);
    if (!f.name.trim() || !f.code.trim()) return setErr("Give the promotion a name and a code");
    if (!value || value <= 0) return setErr(f.type === "PERCENTAGE" ? "Enter a percentage between 1 and 100" : "Enter the discount in naira");
    setBusy(true);
    try {
      await api.post("/v1/admin/promotions", {
        name: f.name.trim(), description: f.description.trim() || undefined, code: f.code.trim().toUpperCase(),
        discountType: f.type, discountValue: value,
        maxDiscount: f.maxDiscount ? toKobo(f.maxDiscount) : undefined, minFare: f.minFare ? toKobo(f.minFare) : undefined,
        usageLimit: f.usageLimit ? Number(f.usageLimit) : undefined, perUserLimit: Number(f.perUserLimit) || 1, firstRideOnly: f.firstRideOnly,
        budget: f.budget ? toKobo(f.budget) : undefined, categoryKeys: f.categories,
        startsAt: new Date(`${f.startsAt}T00:00:00+01:00`).toISOString(), endsAt: new Date(`${f.endsAt}T23:59:59+01:00`).toISOString(),
      });
      toast(`${f.code.toUpperCase()} created.`);
      onCreated();
      onClose();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="New promo code" footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" loading={busy} onClick={submit}>Create code</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Code"><Input value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="WELCOME50" maxLength={20} /></Field>
        <Field label="Name (internal)"><Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Welcome offer" /></Field>
      </div>
      <Field label="Description (optional)"><Textarea rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Discount type">
          <Select value={f.type} onChange={(e) => set("type", e.target.value)}>
            <option value="PERCENTAGE">Percentage off</option>
            <option value="FIXED_AMOUNT">Fixed amount off</option>
          </Select>
        </Field>
        <Field label={f.type === "PERCENTAGE" ? "Percent off" : "Amount off (₦)"}><Input inputMode="decimal" value={f.value} onChange={(e) => set("value", e.target.value)} placeholder={f.type === "PERCENTAGE" ? "50" : "500"} /></Field>
        {f.type === "PERCENTAGE" ? <Field label="Maximum discount (₦)" hint="Optional cap per trip"><Input inputMode="decimal" value={f.maxDiscount} onChange={(e) => set("maxDiscount", e.target.value)} placeholder="1500" /></Field> : null}
        <Field label="Minimum fare (₦)" hint="Optional"><Input inputMode="decimal" value={f.minFare} onChange={(e) => set("minFare", e.target.value)} /></Field>
        <Field label="Total uses" hint="Optional limit"><Input inputMode="numeric" value={f.usageLimit} onChange={(e) => set("usageLimit", e.target.value.replace(/\D/g, ""))} /></Field>
        <Field label="Uses per rider"><Input inputMode="numeric" value={f.perUserLimit} onChange={(e) => set("perUserLimit", e.target.value.replace(/\D/g, ""))} /></Field>
        <Field label="Budget (₦)" hint="Stops when discounts reach this"><Input inputMode="decimal" value={f.budget} onChange={(e) => set("budget", e.target.value)} placeholder="1000000" /></Field>
        <Field label="Starts"><Input type="date" value={f.startsAt} onChange={(e) => set("startsAt", e.target.value)} /></Field>
        <Field label="Ends"><Input type="date" value={f.endsAt} onChange={(e) => set("endsAt", e.target.value)} /></Field>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[13px] font-semibold">Ride types (none ticked = all)</legend>
        <div className="flex flex-wrap gap-3">
          {CATEGORIES.map(([k, label]) => (
            <label key={k} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={f.categories.includes(k)} onChange={(e) => set("categories", e.target.checked ? [...f.categories, k] : f.categories.filter((x) => x !== k))} /> {label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.firstRideOnly} onChange={(e) => set("firstRideOnly", e.target.checked)} /> First ride only</label>
      {err ? <p className="text-sm text-bad">{err}</p> : null}
    </Dialog>
  );
}

function ReferralList() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["referrals"], queryFn: () => api.get<Referrals>("/v1/admin/referrals"), enabled: can("marketing:write") });
  return (
    <Async q={q}>
      {(r) => (
        <>
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Kpi label="Rewards paid" value={naira(r.totalPaid, { compact: true })} note={`${r.data.filter((x) => x.status === "REWARDED").length} successful referral(s)`} />
            <Kpi label="Rider referral" value={naira(r.rewards.passenger)} note="Each, to both riders, after the new rider's first trip" />
            <Kpi label="Driver referral" value={naira(r.rewards.driver)} note={`To the referrer after the new driver's ${r.rewards.driverTrips}th trip`} />
          </section>
          <Card title="Referrals" pad={false}>
            {r.data.length === 0 ? <Empty title="No referrals yet" body="Riders and drivers share their code from the app's Invite screen." /> : (
              <Table head={["Joined", "Invited by", "New user", "Type", "Status", "Paid out"]} minWidth={760}>
                {r.data.map((x) => (
                  <tr key={x.id}>
                    <Td className="text-muted">{dateTime(x.createdAt)}</Td>
                    <Td><b>{x.referrer}</b><div className="text-xs text-muted">{x.referrerPhone}</div></Td>
                    <Td><b>{x.referee}</b><div className="text-xs text-muted">{x.refereePhone}</div></Td>
                    <Td>{titleCase(x.role)}</Td>
                    <Td><Badge tone={REF_STATUS[x.status]?.tone}>{REF_STATUS[x.status]?.label ?? x.status}</Badge></Td>
                    <Td className="tabular">{BigInt(x.paid) > 0n ? naira(x.paid) : "—"}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </Async>
  );
}
