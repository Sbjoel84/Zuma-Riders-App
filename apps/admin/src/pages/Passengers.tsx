import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Async, Badge, Button, Card, Chips, Empty, Input, PageHeader, Table, Td, useConfirm } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { naira, titleCase } from "../lib/format";

interface Row { id: string; userId: string; name: string; phone: string; email: string | null; joinedAt: string; trips: number; rating: string; cancellations: number; wallet: string; status: string; statusReason: string | null }
interface Page { total: number; data: Row[]; nextCursor: string | null }

export function Passengers() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const list = useInfiniteQuery({
    queryKey: ["passengers", status, q],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<Page>(`/v1/admin/passengers?limit=40${status !== "all" ? `&status=${status}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const total = list.data?.pages[0]?.total;
  const refresh = () => qc.invalidateQueries({ queryKey: ["passengers"] });

  return (
    <>
      <PageHeader title="Passengers" subtitle="Accounts, trip history and suspensions" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Chips label="Account status" value={status} onChange={setStatus} options={[{ value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "suspended", label: "Suspended" }]} />
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted">{total !== undefined ? `${total.toLocaleString()} passenger${total === 1 ? "" : "s"}` : ""}</span>
          <label className="flex items-center gap-2 text-sm text-muted">Search <Input className="w-60" placeholder="Name, phone or email" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        </div>
      </div>
      <Card pad={false}>
        <Async q={{ ...list, data: list.data }}>
          {() =>
            rows.length === 0 ? (
              <Empty title={q ? `No passengers match "${q}"` : "No passengers yet"} />
            ) : (
              <>
                <Table head={["Passenger", "Joined", "Trips", "Rating", "Cancellations", "Wallet", "Status", ""]} minWidth={860}>
                  {rows.map((p) => (
                    <tr key={p.id}>
                      <Td><div className="font-semibold">{p.name}</div><div className="text-xs text-muted">{p.phone}{p.email ? ` · ${p.email}` : ""}</div></Td>
                      <Td>{new Date(p.joinedAt).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</Td>
                      <Td className="tabular">{p.trips}</Td>
                      <Td className="tabular">★ {p.rating}</Td>
                      <Td className={`tabular ${p.cancellations > 5 ? "font-semibold text-bad" : ""}`}>{p.cancellations}</Td>
                      <Td className="tabular">{naira(p.wallet)}</Td>
                      <Td><Badge tone={p.status === "ACTIVE" ? "green" : "red"}>{titleCase(p.status)}</Badge>{p.statusReason ? <div className="mt-0.5 max-w-[180px] truncate text-xs text-muted" title={p.statusReason}>{p.statusReason}</div> : null}</Td>
                      <Td className="text-right">
                        {can("passengers:write") ? (
                          p.status === "ACTIVE" ? (
                            <Button size="sm" kind="danger" onClick={() => confirm({ title: `Suspend ${p.name}?`, body: "They're signed out on every device, any open request is cancelled, and they can't book until reactivated.", reason: true, danger: true, confirmLabel: "Suspend passenger", success: `${p.name} suspended.`, run: async (reason) => { await api.post(`/v1/admin/users/${p.userId}/suspend`, { reason }); refresh(); } })}>Suspend</Button>
                          ) : (
                            <Button size="sm" onClick={() => confirm({ title: `Reactivate ${p.name}?`, confirmLabel: "Reactivate", success: `${p.name} reactivated.`, run: async () => { await api.post(`/v1/admin/users/${p.userId}/reactivate`); refresh(); } })}>Reactivate</Button>
                          )
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </Table>
                {list.hasNextPage ? <div className="p-3 text-center"><Button onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>Load more</Button></div> : null}
              </>
            )
          }
        </Async>
      </Card>
    </>
  );
}
