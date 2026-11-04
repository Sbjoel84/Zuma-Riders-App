import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Async, Badge, Button, Card, Chips, Empty, ErrorBox, Field, Input, Kpi, PageHeader, Select, Table, Td, Textarea, useConfirm, useToast } from "../components/ui";
import { api, errorText } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, dateTime, naira, titleCase, toKobo } from "../lib/format";
import { WITHDRAWAL_STATUS } from "../lib/status";

interface Summary {
  days: number; trips: number; gross: string; cashGross: string; walletGross: string; commission: string; cancellationFees: string;
  passengerLiability: string; driverLiability: string; cashCommissionOwed: string; driversOwing: number;
  pendingWithdrawals: { count: number; amount: string };
  integrity: { unbalancedTransactions: number; walletsOutOfSync: number };
}
interface Withdrawal { id: string; driver: string; phone: string; amount: string; bank: string; status: string; rejectionReason: string | null; bankReference: string | null; approvedBy: string | null; createdAt: string; completedAt: string | null }
interface Txn { id: string; type: string; description: string; postedAt: string; entries: { account: string; code: string; direction: string; amount: string }[] }

export function Finance() {
  const { can } = useAuth();
  const [days, setDays] = useState("1");
  const summary = useQuery({ queryKey: ["finance", "summary", days], queryFn: () => api.get<Summary>(`/v1/admin/finance/summary?days=${days}`), refetchInterval: 30_000 });

  return (
    <>
      <PageHeader title="Finance" subtitle="Bookings, commission, wallet balances, payouts and the ledger" actions={<Chips label="Period" value={days} onChange={setDays} options={[{ value: "1", label: "Today" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} />} />
      <Async q={summary}>
        {(s) => (
          <>
            {s.integrity.unbalancedTransactions || s.integrity.walletsOutOfSync ? (
              <ErrorBox error={new Error(`Ledger check failed: ${s.integrity.unbalancedTransactions} unbalanced transaction(s), ${s.integrity.walletsOutOfSync} wallet(s) out of sync with their ledger. Stop payouts and contact engineering.`)} />
            ) : (
              <p className="flex items-center gap-2 text-sm text-ok-text"><span className="size-2 rounded-full bg-ok" />Ledger check passed: every transaction balances and every wallet matches its ledger.</p>
            )}
            <section className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
              <Kpi label="Gross bookings" value={naira(s.gross, { compact: true })} note={`${s.trips} trips · cash ${naira(s.cashGross, { compact: true })} · wallet ${naira(s.walletGross, { compact: true })}`} />
              <Kpi label="Platform commission" value={naira(s.commission, { compact: true })} note={BigInt(s.cancellationFees) > 0n ? `+ ${naira(s.cancellationFees)} cancellation fees` : "Booked when trips complete"} />
              <Kpi label="Cash commission owed" value={naira(s.cashCommissionOwed, { compact: true })} note={`${s.driversOwing} driver(s) below zero`} tone={s.driversOwing ? "down" : "muted"} />
              <Kpi label="Wallet liabilities" value={naira((BigInt(s.passengerLiability) + BigInt(s.driverLiability)).toString(), { compact: true })} note={`Passengers ${naira(s.passengerLiability, { compact: true })} · drivers ${naira(s.driverLiability, { compact: true })}`} />
              <Kpi label="Payouts waiting" value={s.pendingWithdrawals.count} note={naira(s.pendingWithdrawals.amount)} />
            </section>
          </>
        )}
      </Async>
      <div className="grid items-start gap-4 xl:grid-cols-[3fr_2fr]">
        <Withdrawals canPay={can("finance:payout")} />
        {can("finance:adjust") ? <Adjust /> : null}
      </div>
      <Journal />
    </>
  );
}

function Withdrawals({ canPay }: { canPay: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [filter, setFilter] = useState("open");
  const q = useQuery({ queryKey: ["withdrawals", filter], queryFn: () => api.get<Withdrawal[]>(`/v1/admin/finance/withdrawals${filter === "all" ? "" : `?status=${filter}`}`), refetchInterval: 30_000 });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["withdrawals"] });
    qc.invalidateQueries({ queryKey: ["finance"] });
    qc.invalidateQueries({ queryKey: ["journal"] });
    qc.invalidateQueries({ queryKey: ["attention"] });
  };

  return (
    <Card title="Driver payouts" actions={<Chips label="Payout status" value={filter} onChange={setFilter} options={[{ value: "open", label: "To do" }, { value: "COMPLETED", label: "Paid" }, { value: "REJECTED", label: "Rejected" }, { value: "all", label: "All" }]} />}>
      <p className="mb-3 text-xs text-muted">Payouts are manual until bank transfers are connected: approve, send the transfer from the company account, then record it as paid with the bank reference.</p>
      <Async q={q}>
        {(list) =>
          list.length === 0 ? (
            <Empty title={filter === "open" ? "No payouts waiting" : "Nothing here"} />
          ) : (
            <ul className="flex flex-col gap-2">
              {list.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-[#f8f9f6] px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{w.driver} · <span className="tabular">{naira(w.amount)}</span></p>
                    <p className="text-xs text-muted">{w.bank} · {w.phone} · requested {ago(w.createdAt)}{w.bankReference ? ` · ref ${w.bankReference}` : ""}{w.rejectionReason ? ` · ${w.rejectionReason}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {canPay && w.status === "REQUESTED" ? (
                      <>
                        <Button size="sm" kind="danger" onClick={() => confirm({ title: `Reject ${naira(w.amount)} for ${w.driver}?`, body: "The money goes back to their available balance.", reason: true, danger: true, confirmLabel: "Reject payout", success: `Payout rejected. ${naira(w.amount)} returned to ${w.driver}'s balance.`, run: async (reason) => { await api.post(`/v1/admin/finance/withdrawals/${w.id}/reject`, { reason }); refresh(); } })}>Reject</Button>
                        <Button size="sm" kind="primary" onClick={() => confirm({ title: `Approve ${naira(w.amount)} for ${w.driver}?`, body: `Next, transfer ${naira(w.amount)} to ${w.bank}, then record it as paid.`, confirmLabel: "Approve payout", success: "Payout approved. Send the bank transfer, then mark it paid.", run: async () => { await api.post(`/v1/admin/finance/withdrawals/${w.id}/approve`); refresh(); } })}>Approve payout</Button>
                      </>
                    ) : canPay && w.status === "APPROVED" ? (
                      <>
                        <Button size="sm" kind="danger" onClick={() => confirm({ title: "Cancel this approved payout?", body: "Only do this if the transfer was not sent.", reason: true, danger: true, confirmLabel: "Reject payout", success: "Payout rejected and returned to the driver's balance.", run: async (reason) => { await api.post(`/v1/admin/finance/withdrawals/${w.id}/reject`, { reason }); refresh(); } })}>Reject</Button>
                        <Button size="sm" kind="amber" onClick={() => confirm({ title: `Record ${naira(w.amount)} as paid`, body: `Enter the reference of the transfer you sent to ${w.bank}.`, reason: true, reasonLabel: "Bank transfer reference", confirmLabel: "Mark as paid", success: `Payout to ${w.driver} recorded as paid.`, run: async (ref) => { await api.post(`/v1/admin/finance/withdrawals/${w.id}/paid`, { bankReference: ref }); refresh(); } })}>Mark as paid</Button>
                      </>
                    ) : (
                      <Badge tone={WITHDRAWAL_STATUS[w.status]?.tone}>{WITHDRAWAL_STATUS[w.status]?.label ?? w.status}</Badge>
                    )}
                    {w.status === "APPROVED" ? <Badge tone="blue">Awaiting transfer</Badge> : null}
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Async>
    </Card>
  );
}

interface WalletHit { userId: string; name: string; phone: string; ownerType: "PASSENGER" | "DRIVER"; available: string; pending: string; held: string }

function Adjust() {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<WalletHit | null>(null);
  const [direction, setDirection] = useState<"CREDIT" | "DEBIT">("CREDIT");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const hits = useQuery({ queryKey: ["wallet-search", q], enabled: q.length >= 3, queryFn: () => api.get<WalletHit[]>(`/v1/admin/finance/wallets?q=${encodeURIComponent(q)}`) });

  const submit = async () => {
    const k = toKobo(amount);
    if (!pick) return setErr("Choose a wallet");
    if (!k || k === "0") return setErr("Enter an amount in naira, e.g. 5000");
    if (reason.trim().length < 5) return setErr("Explain the adjustment (at least 5 characters)");
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ availableBalance: string }>(`/v1/admin/finance/wallets/${pick.userId}/adjust`, { ownerType: pick.ownerType, direction, amount: k, reason: reason.trim() });
      toast(`${direction === "CREDIT" ? "Credited" : "Debited"} ${naira(k)} ${direction === "CREDIT" ? "to" : "from"} ${pick.name}. New balance ${naira(r.availableBalance)}.`);
      setPick({ ...pick, available: r.availableBalance });
      setAmount("");
      setReason("");
      qc.invalidateQueries({ queryKey: ["finance"] });
      qc.invalidateQueries({ queryKey: ["journal"] });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Wallet adjustment">
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">For cash top-ups paid at the driver hub, goodwill credits and corrections. Each adjustment is a balanced ledger entry and is recorded in the audit log.</p>
        <Field label="Find a person">
          <Input placeholder="Phone or name" value={search} onChange={(e) => { setSearch(e.target.value); setPick(null); }} />
        </Field>
        {hits.data && !pick ? (
          hits.data.length ? (
            <ul className="flex flex-col gap-1">
              {hits.data.map((h) => (
                <li key={h.userId + h.ownerType}>
                  <button className="flex w-full cursor-pointer items-center justify-between rounded-[10px] border border-line-soft px-3 py-2 text-left text-sm hover:border-ink" onClick={() => setPick(h)}>
                    <span><b>{h.name}</b> <span className="text-muted">· {h.phone} · {titleCase(h.ownerType)} wallet</span></span>
                    <span className="tabular">{naira(h.available)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">No wallets found.</p>
        ) : null}
        {pick ? (
          <>
            <p className="rounded-[10px] bg-[#f8f9f6] px-3 py-2 text-sm"><b>{pick.name}</b> · {titleCase(pick.ownerType)} wallet · available <b className="tabular">{naira(pick.available)}</b></p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">
                <Select value={direction} onChange={(e) => setDirection(e.target.value as "CREDIT" | "DEBIT")}>
                  <option value="CREDIT">Credit (add money)</option>
                  <option value="DEBIT">Debit (remove money)</option>
                </Select>
              </Field>
              <Field label="Amount (₦)"><Input inputMode="decimal" placeholder="5000" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            </div>
            <Field label="Reason"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Cash top-up at Wuse hub, receipt #1182" /></Field>
            {err ? <p className="text-sm text-bad">{err}</p> : null}
            <Button kind="primary" loading={busy} onClick={submit}>{direction === "CREDIT" ? "Credit wallet" : "Debit wallet"}</Button>
          </>
        ) : null}
      </div>
    </Card>
  );
}

function Journal() {
  const q = useInfiniteQuery({
    queryKey: ["journal"],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<{ data: Txn[]; nextCursor: string | null }>(`/v1/admin/finance/ledger?limit=25${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];

  const exportCsv = () => {
    const lines = [["posted_at", "transaction_id", "type", "description", "account", "account_code", "debit_ngn", "credit_ngn"].join(",")];
    for (const t of rows) for (const e of t.entries) {
      const amt = (Number(BigInt(e.amount)) / 100).toFixed(2);
      lines.push([t.postedAt, t.id, t.type, `"${t.description.replace(/"/g, '""')}"`, `"${e.account}"`, e.code, e.direction === "DEBIT" ? amt : "", e.direction === "CREDIT" ? amt : ""].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `zuma-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Card title="Ledger journal" pad={false} actions={<Button size="sm" onClick={exportCsv} disabled={!rows.length}>Export loaded rows to CSV</Button>}>
      <p className="px-[18px] pb-2 text-xs text-muted">Every money movement, newest first. Each transaction's debits equal its credits.</p>
      <Async q={{ ...q, data: q.data }}>
        {() =>
          rows.length === 0 ? <Empty title="No transactions yet" /> : (
            <>
              <Table head={["Posted", "Transaction", "Account", "Debit", "Credit"]} minWidth={760}>
                {rows.flatMap((t) =>
                  t.entries.map((e, i) => (
                    <tr key={t.id + i} className={i === 0 ? "" : "[&>td]:border-t-0"}>
                      <Td className="text-muted">{i === 0 ? dateTime(t.postedAt) : ""}</Td>
                      <Td className="font-semibold">{i === 0 ? <>{t.description}<div className="text-xs font-normal text-muted">{titleCase(t.type)}</div></> : ""}</Td>
                      <Td className="text-[13px]">{e.account}</Td>
                      <Td className="tabular">{e.direction === "DEBIT" ? naira(e.amount) : ""}</Td>
                      <Td className="tabular">{e.direction === "CREDIT" ? naira(e.amount) : ""}</Td>
                    </tr>
                  )),
                )}
              </Table>
              {q.hasNextPage ? <div className="p-3 text-center"><Button onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>Load more</Button></div> : null}
            </>
          )
        }
      </Async>
    </Card>
  );
}
