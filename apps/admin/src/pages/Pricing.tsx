import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Async, Badge, Button, Card, Field, Input, PageHeader, Select, Table, Td, Textarea, useToast } from "../components/ui";
import { api, errorText } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dateTime, naira, nairaInput, toKobo } from "../lib/format";

interface Price {
  id: string; categoryKey: string; categoryName: string; version: number; baseFare: string; perKm: string; perMinute: string; minFare: string; maxFare: string; minFarePerKm: string;
  cancellationFeePassenger: string; commissionBps: number; requestTtlSeconds: number; offerTtlSeconds: number; effectiveFrom: string;
}
interface PricingData { serviceArea: { id: string; name: string }; active: Price[]; history: { id: string; categoryName: string; version: number; changeReason: string | null; by: string; effectiveFrom: string; effectiveTo: string | null; commissionBps: number; minFare: string; perKm: string }[] }
interface City { id: string; name: string; areas: { id: string; name: string }[] }

const MONEY: { key: keyof Price; label: string; hint?: string }[] = [
  { key: "baseFare", label: "Base fare" },
  { key: "perKm", label: "Per km" },
  { key: "perMinute", label: "Per minute" },
  { key: "minFare", label: "Minimum fare", hint: "No proposal can go below this" },
  { key: "minFarePerKm", label: "Minimum per km", hint: "Floor for long trips" },
  { key: "maxFare", label: "Maximum fare" },
  { key: "cancellationFeePassenger", label: "Passenger cancellation fee", hint: "After the 2-minute grace period" },
];

export function Pricing() {
  const { can } = useAuth();
  const cities = useQuery({ queryKey: ["config", "areas"], queryFn: () => api.get<City[]>("/v1/admin/config/areas") });
  const [areaId, setAreaId] = useState<string>("");
  useEffect(() => {
    if (!areaId && cities.data?.[0]?.areas[0]) setAreaId(cities.data[0].areas[0].id);
  }, [cities.data, areaId]);
  const q = useQuery({ queryKey: ["pricing", areaId], enabled: !!areaId, queryFn: () => api.get<PricingData>(`/v1/admin/pricing?serviceAreaId=${areaId}`) });
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Fares and commission"
        subtitle="Pricing is versioned. Publishing creates a new version; requests already in negotiation keep the version they started with."
        actions={cities.data ? (
          <Select aria-label="Service area" value={areaId} onChange={(e) => { setAreaId(e.target.value); setEditing(null); }} className="w-56">
            {cities.data.flatMap((c) => c.areas.map((a) => <option key={a.id} value={a.id}>{c.name} · {a.name}</option>))}
          </Select>
        ) : null}
      />
      <Async q={{ ...q, isLoading: q.isLoading || cities.isLoading }}>
        {(p) => (
          <>
            <Card title={`${p.serviceArea.name} · live pricing`} pad={false}>
              <Table head={["Category", "Version", "Base", "Per km", "Per min", "Min fare", "Max fare", "Commission", ""]} minWidth={880}>
                {p.active.map((x) => (
                  <tr key={x.id} className={editing === x.categoryKey ? "bg-[#fff9e8]" : undefined}>
                    <Td className="font-semibold">{x.categoryName}</Td>
                    <Td>v{x.version}</Td>
                    <Td className="tabular">{naira(x.baseFare)}</Td>
                    <Td className="tabular">{naira(x.perKm)}</Td>
                    <Td className="tabular">{naira(x.perMinute)}</Td>
                    <Td className="tabular">{naira(x.minFare)}</Td>
                    <Td className="tabular">{naira(x.maxFare)}</Td>
                    <Td className="tabular">{x.commissionBps / 100}%</Td>
                    <Td className="text-right">{can("pricing:write") ? <Button size="sm" onClick={() => setEditing(x.categoryKey)}>Change</Button> : null}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
            {editing ? <Editor key={editing + p.active.find((a) => a.categoryKey === editing)!.version} areaId={p.serviceArea.id} price={p.active.find((a) => a.categoryKey === editing)!} onDone={() => setEditing(null)} /> : null}
            <Card title="History" pad={false}>
              <Table head={["Category", "Version", "Live from", "Until", "Commission", "Min fare", "Changed by", "Reason"]} minWidth={900}>
                {p.history.map((h) => (
                  <tr key={h.id}>
                    <Td className="font-semibold">{h.categoryName}</Td>
                    <Td>v{h.version} {h.effectiveTo ? null : <Badge tone="green">Live</Badge>}</Td>
                    <Td>{dateTime(h.effectiveFrom)}</Td>
                    <Td>{h.effectiveTo ? dateTime(h.effectiveTo) : "—"}</Td>
                    <Td className="tabular">{h.commissionBps / 100}%</Td>
                    <Td className="tabular">{naira(h.minFare)}</Td>
                    <Td>{h.by}</Td>
                    <Td className="max-w-[260px] text-muted">{h.changeReason}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>
        )}
      </Async>
    </>
  );
}

function Editor({ areaId, price, onDone }: { areaId: string; price: Price; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(MONEY.map((m) => [m.key, nairaInput(price[m.key] as string)])));
  const [commission, setCommission] = useState(String(price.commissionBps / 100));
  const [reqTtl, setReqTtl] = useState(String(price.requestTtlSeconds));
  const [offerTtl, setOfferTtl] = useState(String(price.offerTtlSeconds));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const publish = async () => {
    const money: Record<string, string> = {};
    for (const m of MONEY) {
      const k = toKobo(vals[m.key] ?? "");
      if (k === null) return setErr(`${m.label}: enter an amount in naira`);
      money[m.key] = k;
    }
    const pct = parseFloat(commission);
    if (!(pct >= 0 && pct <= 50)) return setErr("Commission must be between 0% and 50%");
    if (reason.trim().length < 5) return setErr("Explain the change (it's shown in the history)");
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ version: number }>("/v1/admin/pricing", {
        serviceAreaId: areaId, categoryKey: price.categoryKey, ...money, commissionBps: Math.round(pct * 100),
        requestTtlSeconds: parseInt(reqTtl, 10), offerTtlSeconds: parseInt(offerTtl, 10), changeReason: reason.trim(),
      });
      toast(`${price.categoryName} pricing v${r.version} is live.`);
      qc.invalidateQueries({ queryKey: ["pricing"] });
      onDone();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={`New ${price.categoryName} pricing (v${price.version + 1})`} actions={<Button size="sm" kind="ghost" onClick={onDone}>Cancel</Button>}>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {MONEY.map((m) => (
          <Field key={m.key} label={`${m.label} (₦)`} hint={m.hint}>
            <Input inputMode="decimal" value={vals[m.key]} onChange={(e) => setVals((v) => ({ ...v, [m.key]: e.target.value }))} />
          </Field>
        ))}
        <Field label="Commission (%)"><Input inputMode="decimal" value={commission} onChange={(e) => setCommission(e.target.value)} /></Field>
        <Field label="Request lifetime (seconds)" hint="How long passengers wait for offers"><Input inputMode="numeric" value={reqTtl} onChange={(e) => setReqTtl(e.target.value)} /></Field>
        <Field label="Offer lifetime (seconds)"><Input inputMode="numeric" value={offerTtl} onChange={(e) => setOfferTtl(e.target.value)} /></Field>
      </div>
      <div className="mt-3 flex flex-col gap-3">
        <Field label="Reason for change"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Fuel price increase, November" /></Field>
        {err ? <p className="text-sm text-bad">{err}</p> : null}
        <div className="flex justify-end"><Button kind="primary" loading={busy} onClick={publish}>Publish v{price.version + 1}</Button></div>
      </div>
    </Card>
  );
}
