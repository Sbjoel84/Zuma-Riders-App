import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Async, Badge, Button, Card, Chips, Empty, Input, PageHeader, Table, Td, useConfirm } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { naira, titleCase } from "../lib/format";

interface DriverRow {
  id: string; name: string; phone: string; vehicle: string | null; plate: string | null; category: string | null; rating: string; ratingCount: number; trips: number;
  netThisWeek: string; walletBalance: string; availability: string; verificationStatus: string; status: "ACTIVE" | "SUSPENDED" | "PENDING"; suspendedUntil: string | null;
}
interface Page { counts: Record<string, number>; data: DriverRow[]; nextCursor: string | null }

export function Drivers() {
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
    queryKey: ["drivers", status, q],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<Page>(`/v1/admin/drivers?limit=40${status !== "all" ? `&status=${status}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const counts = list.data?.pages[0]?.counts;
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["drivers"] });

  const suspend = (d: DriverRow) =>
    confirm({
      title: `Suspend ${d.name}?`, body: "They're taken offline immediately and can't go online until reactivated.", reason: true, danger: true,
      confirmLabel: "Suspend driver", success: `${d.name} suspended and taken offline.`,
      run: async (reason) => { await api.post(`/v1/admin/drivers/${d.id}/suspend`, { reason }); refresh(); },
    });
  const reactivate = (d: DriverRow) =>
    confirm({ title: `Reactivate ${d.name}?`, body: "They can go online and receive requests again.", confirmLabel: "Reactivate", success: `${d.name} reactivated.`, run: async () => { await api.post(`/v1/admin/drivers/${d.id}/reactivate`); refresh(); } });

  return (
    <>
      <PageHeader title="Drivers" subtitle="Directory, performance and account status" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Chips label="Driver status" value={status} onChange={setStatus} options={[
          { value: "all", label: "All", count: counts?.all },
          { value: "active", label: "Active", count: counts?.active },
          { value: "suspended", label: "Suspended", count: counts?.suspended },
          { value: "pending", label: "Pending verification", count: counts?.pending },
        ]} />
        <label className="flex items-center gap-2 text-sm text-muted">Search <Input className="w-60" placeholder="Name, phone or plate" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      </div>
      <Card pad={false}>
        <Async q={{ ...list, data: list.data }}>
          {() =>
            rows.length === 0 ? (
              <Empty title={q ? `No drivers match "${q}"` : "No drivers here yet"} body={status === "all" && !q ? "Drivers appear once they register in the driver app." : undefined} />
            ) : (
              <>
                <Table head={["Driver", "Vehicle", "Rating", "Trips", "Net this week", "Wallet", "Now", "Status", ""]} minWidth={980}>
                  {rows.map((d) => (
                    <tr key={d.id}>
                      <Td><div className="font-semibold">{d.name}</div><div className="text-xs text-muted">{d.phone}</div></Td>
                      <Td>{d.vehicle ? <><div>{d.vehicle}</div><div className="text-xs tracking-wide text-muted">{d.plate} · {d.category ?? "not approved"}</div></> : <span className="text-muted">No vehicle</span>}</Td>
                      <Td className="tabular">{d.ratingCount ? `★ ${d.rating}` : "—"}</Td>
                      <Td className="tabular">{d.trips}</Td>
                      <Td className="tabular">{naira(d.netThisWeek)}</Td>
                      <Td className={`tabular ${BigInt(d.walletBalance) < 0n ? "text-bad" : ""}`}>{naira(d.walletBalance)}</Td>
                      <Td>{titleCase(d.availability)}</Td>
                      <Td><Badge tone={d.status === "ACTIVE" ? "green" : d.status === "SUSPENDED" ? "red" : "amber"}>{d.status === "PENDING" ? titleCase(d.verificationStatus) : titleCase(d.status)}</Badge></Td>
                      <Td className="text-right">
                        {d.status === "PENDING" && can("drivers:verify") ? <Link to="/verification" className="text-sm font-semibold underline">Review</Link>
                          : can("drivers:write") ? (d.status === "SUSPENDED" ? <Button size="sm" onClick={() => reactivate(d)}>Reactivate</Button> : <Button size="sm" kind="danger" onClick={() => suspend(d)}>Suspend</Button>) : null}
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
