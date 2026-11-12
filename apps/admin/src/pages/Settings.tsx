import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Async, Badge, Button, Card, Chips, Dialog, Empty, Field, Input, PageHeader, Select, Table, Td, useConfirm, useToast } from "../components/ui";
import { api, errorText } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dateTime, titleCase } from "../lib/format";

interface City {
  id: string; key: string; name: string; isLive: boolean; emergencyNumbers: string[];
  areas: { id: string; name: string; status: string; searchRadiusM: number; maxSearchRadiusM: number; radiusStepM: number; restrictedCategoryKeys: string[] }[];
  categories: { categoryId: string; key: string; name: string; seats: number; minYear: number | null; isEnabled: boolean; legalNote: string | null }[];
}

export function Settings() {
  const { can } = useAuth();
  const tabs = [
    { value: "areas", label: "Service areas" },
    { value: "categories", label: "Vehicle categories" },
    ...(can("rbac:write") ? [{ value: "admins", label: "Admins and roles" }] : []),
    ...(can("audit:read") ? [{ value: "audit", label: "Audit log" }] : []),
  ];
  const [tab, setTab] = useState("areas");
  return (
    <>
      <PageHeader title="Settings" subtitle="Where Riders App operates, which vehicles are allowed, who has access, and what changed" />
      <Chips label="Settings section" value={tab} onChange={setTab} options={tabs} />
      {tab === "areas" ? <Areas /> : tab === "categories" ? <Categories /> : tab === "admins" ? <Admins /> : <Audit />}
    </>
  );
}

function Areas() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["config", "areas"], queryFn: () => api.get<City[]>("/v1/admin/config/areas") });
  const [edit, setEdit] = useState<City["areas"][number] | null>(null);
  const [form, setForm] = useState({ status: "ACTIVE", searchRadiusM: "", maxSearchRadiusM: "", radiusStepM: "", reason: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = (a: City["areas"][number]) => {
    setEdit(a);
    setErr(null);
    setForm({ status: a.status, searchRadiusM: String(a.searchRadiusM / 1000), maxSearchRadiusM: String(a.maxSearchRadiusM / 1000), radiusStepM: String(a.radiusStepM / 1000), reason: "" });
  };
  const save = async () => {
    if (!edit) return;
    const m = (s: string) => Math.round(parseFloat(s) * 1000);
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/v1/admin/config/areas/${edit.id}`, { status: form.status, searchRadiusM: m(form.searchRadiusM), maxSearchRadiusM: m(form.maxSearchRadiusM), radiusStepM: m(form.radiusStepM), reason: form.reason });
      toast(`${edit.name} updated.`);
      setEdit(null);
      qc.invalidateQueries({ queryKey: ["config"] });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Async q={q}>
      {(cities) => (
        <>
          {cities.map((c) => (
            <Card key={c.id} title={<h2 className="text-base font-bold">{c.name} {c.isLive ? <Badge tone="green">Live</Badge> : <Badge>Not live</Badge>}</h2>} pad={false}>
              <p className="px-[18px] pb-2 text-xs text-muted">Emergency numbers shown to riders: {c.emergencyNumbers.join(", ") || "none set"}</p>
              <Table head={["Service area", "Status", "Search starts at", "Widens by", "Up to", "Not allowed here", ""]} minWidth={760}>
                {c.areas.map((a) => (
                  <tr key={a.id}>
                    <Td className="font-semibold">{a.name}</Td>
                    <Td><Badge tone={a.status === "ACTIVE" ? "green" : "amber"}>{titleCase(a.status)}</Badge></Td>
                    <Td className="tabular">{a.searchRadiusM / 1000} km</Td>
                    <Td className="tabular">{a.radiusStepM / 1000} km</Td>
                    <Td className="tabular">{a.maxSearchRadiusM / 1000} km</Td>
                    <Td>{a.restrictedCategoryKeys.map(titleCase).join(", ") || "—"}</Td>
                    <Td className="text-right">{can("config:write") ? <Button size="sm" onClick={() => open(a)}>Edit</Button> : null}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          ))}
          <Dialog open={!!edit} onClose={() => setEdit(null)} title={`Edit ${edit?.name ?? ""}`} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button kind="primary" loading={busy} onClick={save}>Save</Button></>}>
            <Field label="Status" hint="Paused areas accept no new requests">
              <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="ACTIVE">Active</option><option value="PAUSED">Paused</option><option value="RESTRICTED">Restricted</option>
              </Select>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Start radius (km)"><Input inputMode="decimal" value={form.searchRadiusM} onChange={(e) => setForm({ ...form, searchRadiusM: e.target.value })} /></Field>
              <Field label="Widen by (km)"><Input inputMode="decimal" value={form.radiusStepM} onChange={(e) => setForm({ ...form, radiusStepM: e.target.value })} /></Field>
              <Field label="Maximum (km)"><Input inputMode="decimal" value={form.maxSearchRadiusM} onChange={(e) => setForm({ ...form, maxSearchRadiusM: e.target.value })} /></Field>
            </div>
            <Field label="Reason (saved to the audit log)" error={err}><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          </Dialog>
        </>
      )}
    </Async>
  );
}

function Categories() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["config", "areas"], queryFn: () => api.get<City[]>("/v1/admin/config/areas") });
  return (
    <Async q={q}>
      {(cities) => (
        <>
          {cities.map((c) => (
            <Card key={c.id} title={`Vehicle categories in ${c.name}`}>
              <ul className="flex flex-col gap-2">
                {c.categories.map((v) => (
                  <li key={v.categoryId} className="flex flex-wrap items-center gap-3 rounded-[10px] bg-[#f8f9f6] px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{v.name}</p>
                      <p className="text-xs text-muted">{v.seats} seat{v.seats > 1 ? "s" : ""}{v.minYear ? ` · vehicles ${v.minYear} or newer` : ""}{v.legalNote ? ` · ${v.legalNote}` : ""}</p>
                    </div>
                    <Badge tone={v.isEnabled ? "green" : "neutral"}>{v.isEnabled ? "Enabled" : "Off"}</Badge>
                    {can("config:write") ? (
                      <Button size="sm" kind={v.isEnabled ? "danger" : "secondary"} onClick={() => confirm({
                        title: `${v.isEnabled ? "Turn off" : "Enable"} ${v.name} in ${c.name}?`,
                        body: v.isEnabled ? "Passengers stop seeing it. Drivers in this category can't go online here." : v.legalNote ? `Check first: ${v.legalNote}.` : "Passengers will see it when they book.",
                        reason: true, danger: v.isEnabled, confirmLabel: v.isEnabled ? "Turn off" : "Enable", success: `${v.name} ${v.isEnabled ? "turned off" : "enabled"} in ${c.name}.`,
                        run: async (reason) => { await api.patch(`/v1/admin/config/cities/${c.id}/categories/${v.categoryId}`, { isEnabled: !v.isEnabled, reason }); qc.invalidateQueries({ queryKey: ["config"] }); },
                      })}>{v.isEnabled ? "Turn off" : "Enable"}</Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </>
      )}
    </Async>
  );
}

interface AdminsData { admins: { id: string; userId: string; name: string; phone: string; status: string; roles: { key: string; name: string }[]; lastLoginAt: string | null; createdAt: string; twoFactor: boolean }[]; roles: { key: string; name: string; permissions: string[] }[] }

function Admins() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = useAuth();
  const q = useQuery({ queryKey: ["admins"], queryFn: () => api.get<AdminsData>("/v1/admin/admins") });
  const [invite, setInvite] = useState(false);
  const [form, setForm] = useState({ phone: "", firstName: "", lastName: "", roleKey: "ops_agent" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admins"] });

  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post("/v1/admin/admins", form);
      toast(`${form.firstName} added. They sign in with ${form.phone} and a text code.`);
      setInvite(false);
      setForm({ phone: "", firstName: "", lastName: "", roleKey: "ops_agent" });
      refresh();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Async q={q}>
      {(d) => (
        <>
          <Card title="Admins" pad={false} actions={<Button kind="primary" size="sm" onClick={() => setInvite(true)}>Add admin</Button>}>
            <Table head={["Admin", "Role", "Two-factor", "Last sign-in", "Added", ""]} minWidth={860}>
              {d.admins.map((a) => {
                const self = a.userId === me?.id;
                const revoked = a.roles.length === 0;
                return (
                  <tr key={a.id}>
                    <Td><div className="font-semibold">{a.name}{self ? " (you)" : ""}</div><div className="text-xs text-muted">{a.phone}</div></Td>
                    <Td>
                      {self || revoked ? (revoked ? <Badge tone="red">Access removed</Badge> : a.roles.map((r) => r.name).join(", ")) : (
                        <Select aria-label={`Role for ${a.name}`} className="w-48" value={a.roles[0]?.key} onChange={(e) => {
                          const roleKey = e.target.value;
                          confirm({ title: `Change ${a.name}'s role?`, body: "They're signed out and get the new permissions when they sign back in.", confirmLabel: "Change role", success: "Role changed.", run: async () => { await api.put(`/v1/admin/admins/${a.userId}/role`, { roleKey }); refresh(); } });
                        }}>
                          {d.roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                        </Select>
                      )}
                    </Td>
                    <Td>
                      {a.twoFactor ? <Badge tone="green">On</Badge> : <Badge tone="amber">Off</Badge>}
                      {a.twoFactor && !self && !revoked ? (
                        <button className="ml-2 cursor-pointer text-xs font-semibold underline" onClick={() => confirm({ title: `Reset ${a.name}'s two-factor?`, body: "Use this when they've lost their phone. Check who they are first. They're signed out and must set up the authenticator app again.", reason: true, danger: true, confirmLabel: "Reset two-factor", success: "Two-factor reset.", run: async (reason) => { await api.post(`/v1/admin/admins/${a.userId}/reset-2fa`, { reason }); refresh(); } })}>Reset</button>
                      ) : null}
                    </Td>
                    <Td className="text-muted">{a.lastLoginAt ? dateTime(a.lastLoginAt) : "Never"}</Td>
                    <Td className="text-muted">{dateTime(a.createdAt)}</Td>
                    <Td className="text-right">{!self && !revoked ? <Button size="sm" kind="danger" onClick={() => confirm({ title: `Remove ${a.name}'s access?`, body: "They're signed out immediately. Their past actions stay in the audit log.", danger: true, confirmLabel: "Remove access", success: "Access removed.", run: async () => { await api.post(`/v1/admin/admins/${a.userId}/revoke`); refresh(); } })}>Remove access</Button> : null}</Td>
                  </tr>
                );
              })}
            </Table>
          </Card>
          <Card title="What each role can do">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {d.roles.map((r) => (
                <div key={r.key} className="rounded-[10px] bg-[#f8f9f6] p-3">
                  <p className="text-sm font-semibold">{r.name}</p>
                  <p className="mt-1 text-xs text-muted">{r.permissions.map((p) => p.replace(":", " · ")).join(", ")}</p>
                </div>
              ))}
            </div>
          </Card>
          <Dialog open={invite} onClose={() => setInvite(false)} title="Add an admin" footer={<><Button onClick={() => setInvite(false)}>Cancel</Button><Button kind="primary" loading={busy} onClick={add}>Add admin</Button></>}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name"><Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></Field>
              <Field label="Last name"><Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></Field>
            </div>
            <Field label="Phone number" hint="They sign in with this number and a text code"><Input inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Role" error={err}>
              <Select value={form.roleKey} onChange={(e) => setForm({ ...form, roleKey: e.target.value })}>
                {d.roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
              </Select>
            </Field>
          </Dialog>
        </>
      )}
    </Async>
  );
}

function Audit() {
  const [kind, setKind] = useState("actions");
  const q = useInfiniteQuery({
    queryKey: ["audit", kind],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<{ data: Array<Record<string, unknown> & { id: string; at: string; by: string }>; nextCursor: string | null }>(`/v1/admin/audit?kind=${kind}${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <>
      <Chips label="Audit log" value={kind} onChange={setKind} options={[{ value: "actions", label: "Admin actions" }, { value: "changes", label: "Configuration changes" }]} />
      <Card pad={false}>
        <Async q={{ ...q, data: q.data }}>
          {() =>
            rows.length === 0 ? <Empty title="Nothing logged yet" /> : (
              <>
                {kind === "actions" ? (
                  <Table head={["When", "Admin", "Action", "Target", "Reason"]} minWidth={760}>
                    {rows.map((r) => (
                      <tr key={r.id}><Td className="text-muted">{dateTime(r.at)}</Td><Td>{r.by}</Td><Td className="font-semibold">{String(r.action).replace(/[._]/g, " ")}</Td><Td className="text-xs text-muted">{String(r.targetType)} {String(r.targetId).slice(0, 10)}…</Td><Td className="max-w-[320px]">{(r.reason as string) ?? "—"}</Td></tr>
                    ))}
                  </Table>
                ) : (
                  <Table head={["When", "Admin", "Change", "Before", "After"]} minWidth={900}>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <Td className="text-muted">{dateTime(r.at)}</Td><Td>{r.by}</Td><Td className="font-semibold">{titleCase(String(r.operation))} {String(r.entity)}</Td>
                        <Td><pre className="max-h-28 max-w-[320px] overflow-auto text-[11px] text-muted">{r.before ? JSON.stringify(r.before, null, 1) : "—"}</pre></Td>
                        <Td><pre className="max-h-28 max-w-[320px] overflow-auto text-[11px]">{r.after ? JSON.stringify(r.after, null, 1) : "—"}</pre></Td>
                      </tr>
                    ))}
                  </Table>
                )}
                {q.hasNextPage ? <div className="p-3 text-center"><Button onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>Load more</Button></div> : null}
              </>
            )
          }
        </Async>
      </Card>
    </>
  );
}
