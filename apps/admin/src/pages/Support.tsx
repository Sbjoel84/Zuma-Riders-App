import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Async, Badge, Button, Card, Chips, Empty, PageHeader, Select, Table, Td, Textarea, useConfirm, useToast } from "../components/ui";
import { api, errorText } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, dateTime, titleCase } from "../lib/format";
import { PRIORITY, RIDE_STATUS, TICKET_STATUS } from "../lib/status";

interface TicketRow { id: string; number: string; subject: string; category: string; priority: string; status: string; requester: string; requesterRole: string; rideCode: string | null; assignee: string | null; messages: number; createdAt: string; updatedAt: string }
interface Ticket {
  id: string; number: string; subject: string; category: string; priority: string; status: string; resolution: string | null;
  requester: { id: string; name: string; phone: string }; ride: { id: string; code: string; status: string } | null; assignee: { id: string; name: string } | null;
  messages: { id: string; author: string; fromStaff: boolean; internal: boolean; body: string; at: string }[];
}

export function Support() {
  const { id } = useParams();
  const [filter, setFilter] = useState("open");
  const q = useQuery({ queryKey: ["tickets", filter], queryFn: () => api.get<{ counts: Record<string, number>; data: TicketRow[] }>(`/v1/admin/support/tickets${filter === "all" ? "" : filter === "mine" ? "?mine=1" : `?status=${filter}`}`), refetchInterval: 20_000 });
  const c = q.data?.counts ?? {};

  return (
    <>
      <PageHeader title="Support" subtitle="Complaints, lost property, payment and account issues from passengers and drivers" />
      <Chips label="Ticket status" value={filter} onChange={setFilter} options={[
        { value: "open", label: "Open", count: (c.OPEN ?? 0) + (c.ASSIGNED ?? 0) },
        { value: "mine", label: "Assigned to me" },
        { value: "AWAITING_USER", label: "Awaiting customer", count: c.AWAITING_USER ?? 0 },
        { value: "RESOLVED", label: "Resolved", count: c.RESOLVED ?? 0 },
        { value: "all", label: "All" },
      ]} />
      <div className="grid items-start gap-4 2xl:grid-cols-[3fr_2fr]">
        <Card pad={false}>
          <Async q={q}>
            {(d) =>
              d.data.length === 0 ? <Empty title="No tickets here" body="Passengers and drivers open tickets from the app's Help screen and after a trip." /> : (
                <Table head={["Ticket", "From", "Category", "Priority", "Status", "Assignee", "Updated"]} minWidth={820}>
                  {d.data.map((t) => (
                    <tr key={t.id} className={t.id === id ? "bg-[#fff9e8]" : undefined}>
                      <Td><Link to={`/support/${t.id}`} className="font-bold underline">{t.number}</Link><div className="max-w-[240px] truncate text-xs text-muted">{t.subject}</div></Td>
                      <Td>{t.requester}<div className="text-xs text-muted">{t.requesterRole}{t.rideCode ? ` · ${t.rideCode}` : ""}</div></Td>
                      <Td>{titleCase(t.category)}</Td>
                      <Td><Badge tone={PRIORITY[t.priority]}>{titleCase(t.priority)}</Badge></Td>
                      <Td><Badge tone={TICKET_STATUS[t.status]?.tone}>{TICKET_STATUS[t.status]?.label}</Badge></Td>
                      <Td>{t.assignee ?? <span className="text-muted">Unassigned</span>}</Td>
                      <Td className="text-muted">{ago(t.updatedAt)}</Td>
                    </tr>
                  ))}
                </Table>
              )
            }
          </Async>
        </Card>
        {id ? <Thread id={id} /> : <Card><Empty title="Select a ticket" body="Open a ticket to read the conversation and reply." /></Card>}
      </div>
    </>
  );
}

function Thread({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  const { me } = useAuth();
  const q = useQuery({ queryKey: ["ticket", id], queryFn: () => api.get<Ticket>(`/v1/admin/support/tickets/${id}`), refetchInterval: 15_000 });
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ticket", id] });
    qc.invalidateQueries({ queryKey: ["tickets"] });
    qc.invalidateQueries({ queryKey: ["attention"] });
  };

  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api.post(`/v1/admin/support/tickets/${id}/messages`, { body: body.trim(), internal });
      toast(internal ? "Internal note added. The customer can't see it." : "Reply sent. The ticket is now awaiting the customer.");
      setBody("");
      refresh();
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="2xl:sticky 2xl:top-4">
      <Async q={q}>
        {(t) => {
          const mine = t.assignee?.name === me?.name;
          const done = t.status === "RESOLVED" || t.status === "CLOSED";
          return (
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-base font-bold">{t.number} · {t.subject}</h2>
                  <p className="text-[13px] text-muted">{t.requester.name} · {t.requester.phone}{t.ride ? <> · <Link to={`/rides/${t.ride.id}`} className="underline">{t.ride.code}</Link> ({RIDE_STATUS[t.ride.status]?.label})</> : null}</p>
                </div>
                <Button size="sm" kind="ghost" onClick={() => nav("/support")}>Close</Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone={TICKET_STATUS[t.status]?.tone}>{TICKET_STATUS[t.status]?.label}</Badge>
                <Badge tone={PRIORITY[t.priority]}>{titleCase(t.priority)} priority</Badge>
                <Badge>{titleCase(t.category)}</Badge>
                <Badge tone={t.assignee ? "blue" : "neutral"}>{t.assignee ? `Assigned to ${t.assignee.name}` : "Unassigned"}</Badge>
              </div>
              <ol className="flex max-h-[420px] flex-col gap-2 overflow-y-auto">
                {t.messages.map((m) => (
                  <li key={m.id} className={clsx("flex flex-col gap-0.5 rounded-[12px] px-3 py-2.5 text-sm", m.internal ? "ml-6 border border-dashed border-violet bg-violet-soft" : m.fromStaff ? "ml-6 bg-ground" : "mr-6 bg-amber-soft")}>
                    <span className="text-xs font-semibold text-muted">{m.author}{m.internal ? " · internal note" : ""} · {dateTime(m.at)}</span>
                    <span className="whitespace-pre-wrap">{m.body}</span>
                  </li>
                ))}
              </ol>
              {t.resolution ? <p className="rounded-[10px] bg-ok-soft px-3 py-2 text-sm text-ok-text">Resolution: {t.resolution}</p> : null}
              {!done ? (
                <>
                  <Textarea rows={3} aria-label="Message" placeholder={internal ? "Note for the team (not visible to the customer)" : `Reply to ${t.requester.name.split(" ")[0]}`} value={body} onChange={(e) => setBody(e.target.value)} />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Select aria-label="Message type" className="w-auto" value={internal ? "note" : "reply"} onChange={(e) => setInternal(e.target.value === "note")}>
                      <option value="reply">Reply to customer</option>
                      <option value="note">Internal note</option>
                    </Select>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={async () => { await api.post(`/v1/admin/support/tickets/${id}/assign`, mine ? { unassign: true } : {}); toast(mine ? "Unassigned." : "Assigned to you."); refresh(); }}>{mine ? "Unassign me" : "Assign to me"}</Button>
                      <Button onClick={() => confirm({ title: `Resolve ${t.number}?`, reason: true, reasonLabel: "Resolution (shown on the ticket)", confirmLabel: "Mark resolved", success: `${t.number} resolved.`, run: async (resolution) => { await api.post(`/v1/admin/support/tickets/${id}/status`, { status: "RESOLVED", resolution }); refresh(); } })}>Mark resolved</Button>
                      <Button kind="primary" loading={busy} disabled={!body.trim()} onClick={send}>{internal ? "Add note" : "Send reply"}</Button>
                    </div>
                  </div>
                </>
              ) : (
                <Button onClick={async () => { await api.post(`/v1/admin/support/tickets/${id}/status`, { status: "OPEN" }); toast(`${t.number} reopened.`); refresh(); }}>Reopen ticket</Button>
              )}
            </div>
          );
        }}
      </Async>
    </Card>
  );
}
