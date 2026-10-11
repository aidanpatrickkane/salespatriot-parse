"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  type Rfq,
  type RfqData,
  SET_ASIDES,
  daysUntil,
  dibbsNsnUrl,
  dibbsSolicitationUrl,
  formatNsn,
} from "@/lib/rfq";

const PAGE_SIZE = 50;

type DueWindow = "any" | "3" | "6" | "10";
type SortKey = "returnBy" | "posted" | "qty" | "solicitation";

type Filters = {
  query: string;
  due: DueWindow;
  includeClosed: boolean;
  setAsides: Set<string>;
  fscs: Set<string>;
  sourceQuery: string;
  posted: Set<string>;
  minQty: string;
  maxQty: string;
};

const EMPTY_FILTERS: Filters = {
  query: "",
  due: "any",
  includeClosed: false,
  setAsides: new Set(),
  fscs: new Set(),
  sourceQuery: "",
  posted: new Set(),
  minQty: "",
  maxQty: "",
};

type FacetKey = "due" | "setAside" | "fsc" | "posted";

const norm = (s: string) => s.toLowerCase().replace(/[-\s,]+/g, "");

function toggle(set: Set<string>, value: string) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function shortDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SolicitationBrowser({
  data,
  today,
  syncedLabel,
}: {
  data: RfqData;
  today: string;
  syncedLabel: string;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "returnBy", dir: 1 });
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fscQuery, setFscQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const query = useDeferredValue(filters.query);
  const sourceQuery = useDeferredValue(filters.sourceQuery);

  const update = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  };

  // Precompute per-row values that every filter pass needs.
  const rows = useMemo(
    () =>
      data.rfqs.map((r) => ({
        rfq: r,
        days: daysUntil(r.returnBy, today),
        sourceHaystack: norm(r.approvedSources.flatMap((s) => [s.cage, s.partNumber, s.company]).join("|")),
        haystack: norm(
          [
            r.solicitation,
            r.nsn,
            r.nomenclature,
            r.purchaseRequest,
            r.buyerCode,
            data.fscNames[r.fsc] ?? "",
            ...r.approvedSources.flatMap((s) => [s.cage, s.partNumber, s.company]),
          ].join("|"),
        ),
      })),
    [data, today],
  );

  type Row = (typeof rows)[number];

  const { filtered, facets } = useMemo(() => {
    const tokens = query.split(/\s+/).map(norm).filter(Boolean);
    const sourceTokens = sourceQuery.split(/\s+/).map(norm).filter(Boolean);
    const minQty = Number(filters.minQty) || 0;
    const maxQty = Number(filters.maxQty) || Infinity;

    const preds: Record<FacetKey | "search" | "sources" | "qty" | "closed", (row: Row) => boolean> = {
      search: (row) => tokens.every((t) => row.haystack.includes(t)),
      closed: (row) => filters.includeClosed || row.days >= 0,
      due: (row) => filters.due === "any" || row.days >= Number(filters.due),
      setAside: (row) => filters.setAsides.size === 0 || filters.setAsides.has(row.rfq.setAside),
      fsc: (row) => filters.fscs.size === 0 || filters.fscs.has(row.rfq.fsc),
      sources: (row) => sourceTokens.every((t) => row.sourceHaystack.includes(t)),
      posted: (row) => filters.posted.size === 0 || filters.posted.has(row.rfq.posted),
      qty: (row) => row.rfq.qty >= minQty && row.rfq.qty <= maxQty,
    };
    const predList = Object.entries(preds) as [keyof typeof preds, (row: Row) => boolean][];

    const filtered: Row[] = [];
    // Facet counts ignore their own filter, so you can see what selecting another option would give you.
    const facets = {
      due: { "3": 0, "6": 0, "10": 0, any: 0 } as Record<DueWindow, number>,
      setAside: {} as Record<string, number>,
      fsc: {} as Record<string, number>,
      posted: {} as Record<string, number>,
    };
    const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

    for (const row of rows) {
      let failed: string | null = null;
      let failures = 0;
      for (const [key, pred] of predList) {
        if (!pred(row)) {
          failed = key;
          if (++failures > 1) break;
        }
      }
      if (failures > 1) continue;
      if (failures === 0) filtered.push(row);
      const r = row.rfq;
      if (failures === 0 || failed === "due") {
        facets.due.any++;
        if (row.days >= 3) facets.due["3"]++;
        if (row.days >= 6) facets.due["6"]++;
        if (row.days >= 10) facets.due["10"]++;
      }
      if (failures === 0 || failed === "setAside") inc(facets.setAside, r.setAside);
      if (failures === 0 || failed === "fsc") inc(facets.fsc, r.fsc);
      if (failures === 0 || failed === "posted") inc(facets.posted, r.posted);
    }

    const { key, dir } = sort;
    filtered.sort((a, b) => {
      const av = a.rfq[key];
      const bv = b.rfq[key];
      const c = av < bv ? -1 : av > bv ? 1 : 0;
      return c * dir || a.rfq.solicitation.localeCompare(b.rfq.solicitation);
    });

    return { filtered, facets };
  }, [rows, query, sourceQuery, filters, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selected = selectedId ? data.rfqs.find((r) => r.id === selectedId) ?? null : null;

  const fscOptions = useMemo(() => {
    const q = fscQuery.trim().toLowerCase();
    return Object.entries(facets.fsc)
      .filter(([code]) => code)
      .filter(([code]) => !q || code.includes(q) || (data.fscNames[code] ?? "").toLowerCase().includes(q))
      .sort((a, b) => b[1] - a[1]);
  }, [facets.fsc, fscQuery, data.fscNames]);

  const activeCount =
    (filters.due !== "any" ? 1 : 0) +
    (filters.includeClosed ? 1 : 0) +
    filters.setAsides.size +
    filters.fscs.size +
    (filters.sourceQuery.trim() ? 1 : 0) +
    filters.posted.size +
    (filters.minQty || filters.maxQty ? 1 : 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        document.getElementById("search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const setSortKey = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "qty" || key === "posted" ? -1 : 1 }));

  const exportCsv = () => {
    const header = [
      "Solicitation",
      "NSN/Part",
      "Nomenclature",
      "FSC",
      "Qty",
      "Unit",
      "Set-aside",
      "Return by",
      "Posted",
      "Purchase request",
      "Approved sources",
      "DIBBS link",
    ];
    const lines = filtered.map(({ rfq: r }) =>
      [
        r.solicitation,
        formatNsn(r.nsn),
        r.nomenclature,
        r.fsc,
        r.qty,
        r.unit,
        SET_ASIDES[r.setAside]?.label ?? r.setAside,
        r.returnBy,
        r.posted,
        r.purchaseRequest,
        r.approvedSources.map((s) => `${s.cage} ${s.partNumber}`).join("; "),
        dibbsSolicitationUrl(r.solicitation),
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dibbs-rfqs-${today}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex min-h-full flex-1 flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-line bg-panel/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 lg:px-6">
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold tracking-tight">Solicitation Browser</h1>
            <p className="text-xs text-muted">
              DIBBS RFQs posted {data.dates.map(shortDate).reverse().join(", ")}
              {" "}· synced {syncedLabel}
            </p>
          </div>
          <div className="relative order-last w-full sm:order-none sm:w-auto sm:flex-1 sm:max-w-xl">
            <input
              id="search"
              type="search"
              autoFocus
              value={filters.query}
              onChange={(e) => update({ query: e.target.value })}
              placeholder="Search solicitation, NSN, item name, CAGE, part number…"
              className="w-full rounded-md border border-line bg-background px-3 py-2 pr-8 text-sm outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-line px-1.5 font-mono text-[10px] text-muted">
              /
            </kbd>
          </div>
          <button
            onClick={() => setShowFilters((s) => !s)}
            className="ml-auto rounded-md border border-line px-3 py-1.5 text-sm lg:hidden"
          >
            Filters{activeCount > 0 && ` (${activeCount})`}
          </button>
        </div>
      </header>

      <div className="flex flex-1">
        {/* Filters */}
        <aside
          className={`${showFilters ? "block" : "hidden"} ${collapsed ? "lg:hidden" : "lg:block"} fixed inset-0 top-[105px] z-10 w-full overflow-y-auto border-r border-line bg-panel p-4 sm:top-[61px] lg:sticky lg:top-[61px] lg:h-[calc(100vh-61px)] lg:w-72 lg:shrink-0`}
        >
          <div className="mb-4 flex items-center justify-between">
            <button
              onClick={() => {
                setCollapsed(true);
                setShowFilters(false);
              }}
              className="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-semibold uppercase tracking-wider text-muted hover:bg-subtle hover:text-foreground"
              title="Hide filters"
              aria-label="Hide filters"
            >
              <span aria-hidden>«</span> Filters
            </button>
            {activeCount > 0 && (
              <button
                onClick={() => {
                  update({ ...EMPTY_FILTERS, query: filters.query });
                  setFscQuery("");
                }}
                className="text-xs text-accent hover:underline"
              >
                Clear all
              </button>
            )}
          </div>

          <FilterGroup title="Posted">
            {data.dates.map((d) => (
              <CheckRow
                key={d}
                checked={filters.posted.has(d)}
                onChange={() => update({ posted: toggle(filters.posted, d) })}
                label={shortDate(d)}
                count={facets.posted[d] ?? 0}
              />
            ))}
          </FilterGroup>
          <FilterGroup title="Days until close" hint="At least this many days left before the return-by date">
            <div className="grid grid-cols-4 gap-1">
              {(["3", "6", "10", "any"] as DueWindow[]).map((d) => (
                <button
                  key={d}
                  onClick={() => update({ due: d })}
                  className={`rounded-md border px-2 py-1.5 text-xs ${
                    filters.due === d
                      ? "border-accent bg-accent-soft font-medium text-accent"
                      : "border-line hover:bg-subtle"
                  }`}
                >
                  <div>{d === "any" ? "Any" : `${d}+`}</div>
                  <div className="text-[10px] tabular-nums text-muted">{facets.due[d].toLocaleString()}</div>
                </button>
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={filters.includeClosed}
                onChange={(e) => update({ includeClosed: e.target.checked })}
              />
              Include past return-by date
            </label>
          </FilterGroup>

          <FilterGroup title="Set-aside" hint="Who is eligible to bid">
            {Object.entries(SET_ASIDES)
              .filter(([code]) => facets.setAside[code] || filters.setAsides.has(code))
              .map(([code, { label }]) => (
                <CheckRow
                  key={code}
                  checked={filters.setAsides.has(code)}
                  onChange={() => update({ setAsides: toggle(filters.setAsides, code) })}
                  label={label}
                  count={facets.setAside[code] ?? 0}
                />
              ))}
          </FilterGroup>

          <FilterGroup title="Category (FSC)" hint="Federal Supply Class — first 4 digits of the NSN">
            {filters.fscs.size > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {[...filters.fscs].map((code) => (
                  <button
                    key={code}
                    onClick={() => update({ fscs: toggle(filters.fscs, code) })}
                    className="rounded bg-accent-soft px-1.5 py-0.5 text-xs text-accent"
                    title={data.fscNames[code]}
                  >
                    {code} ×
                  </button>
                ))}
              </div>
            )}
            <input
              value={fscQuery}
              onChange={(e) => setFscQuery(e.target.value)}
              placeholder="Find a category…"
              className="mb-1 w-full rounded-md border border-line bg-background px-2 py-1.5 text-xs outline-none focus:border-accent"
            />
            <div className="max-h-56 overflow-y-auto pr-1">
              {fscOptions.map(([code, count]) => (
                <CheckRow
                  key={code}
                  checked={filters.fscs.has(code)}
                  onChange={() => update({ fscs: toggle(filters.fscs, code) })}
                  label={
                    <span className="flex min-w-0 gap-1.5">
                      <span className="font-mono text-xs text-muted">{code}</span>
                      <span className="truncate">{data.fscNames[code] ?? "—"}</span>
                    </span>
                  }
                  title={data.fscNames[code]}
                  count={count}
                />
              ))}
              {fscOptions.length === 0 && <p className="py-1 text-xs text-muted">No matching categories</p>}
            </div>
          </FilterGroup>

          <FilterGroup title="Quantity">
            <div className="flex items-center gap-2">
              <input
                inputMode="numeric"
                value={filters.minQty}
                onChange={(e) => update({ minQty: e.target.value.replace(/\D/g, "") })}
                placeholder="Min"
                className="w-full rounded-md border border-line bg-background px-2 py-1.5 text-sm outline-none focus:border-accent"
              />
              <span className="text-muted">–</span>
              <input
                inputMode="numeric"
                value={filters.maxQty}
                onChange={(e) => update({ maxQty: e.target.value.replace(/\D/g, "") })}
                placeholder="Max"
                className="w-full rounded-md border border-line bg-background px-2 py-1.5 text-sm outline-none focus:border-accent"
              />
            </div>
          </FilterGroup>

          <FilterGroup title="Approved sources" hint="Find items where a given company is a listed approved source">
            <input
              type="search"
              value={filters.sourceQuery}
              onChange={(e) => update({ sourceQuery: e.target.value })}
              placeholder="CAGE code or part number…"
              className="w-full rounded-md border border-line bg-background px-2 py-1.5 text-sm outline-none placeholder:text-muted focus:border-accent"
            />
          </FilterGroup>
        </aside>

        {/* Results */}
        <main className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 lg:px-6">
            <p className="flex items-center gap-3 text-sm">
              {collapsed && (
                <button
                  onClick={() => setCollapsed(false)}
                  className="hidden rounded-md border border-line bg-panel px-2.5 py-1 text-xs hover:bg-subtle lg:inline-block"
                >
                  » Filters{activeCount > 0 && ` (${activeCount})`}
                </button>
              )}
              <span>
              <span className="font-semibold tabular-nums">{filtered.length.toLocaleString()}</span>{" "}
              <span className="text-muted">
                of {data.rfqs.length.toLocaleString()} line items
                {!filters.includeClosed && " · open only"}
              </span>
              </span>
            </p>
            <button
              onClick={exportCsv}
              disabled={filtered.length === 0}
              className="rounded-md border border-line bg-panel px-3 py-1.5 text-xs hover:bg-subtle disabled:opacity-50"
            >
              Export CSV
            </button>
          </div>

          <div className="overflow-x-auto border-y border-line bg-panel">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-line text-left text-xs text-muted">
                <tr>
                  <SortHeader label="Solicitation" k="solicitation" sort={sort} onSort={setSortKey} />
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <SortHeader label="Qty" k="qty" sort={sort} onSort={setSortKey} align="right" />
                  <th className="px-3 py-2 font-medium">Set-aside</th>
                  <th className="px-3 py-2 font-medium">Sources</th>
                  <SortHeader label="Return by" k="returnBy" sort={sort} onSort={setSortKey} />
                  <SortHeader label="Posted" k="posted" sort={sort} onSort={setSortKey} />
                  <th className="w-10 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map(({ rfq: r, days }) => (
                  <tr
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    className={`cursor-pointer border-b border-line last:border-0 hover:bg-subtle ${
                      selectedId === r.id ? "bg-accent-soft" : ""
                    }`}
                  >
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[13px]">{r.solicitation}</td>
                    <td className="max-w-[280px] px-3 py-2.5">
                      <div className="truncate font-medium">{r.nomenclature}</div>
                      <div className="font-mono text-xs text-muted">
                        {formatNsn(r.nsn)}
                        {r.itemType === "part" && " (part #)"}
                      </div>
                    </td>
                    <td className="max-w-[200px] px-3 py-2.5" title={data.fscNames[r.fsc]}>
                      <div className="font-mono text-xs">{r.fsc || "—"}</div>
                      <div className="truncate text-xs text-muted">{data.fscNames[r.fsc]}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                      {r.qty.toLocaleString()} <span className="text-xs text-muted">{r.unit}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <SetAsideBadge code={r.setAside} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                      {r.approvedSources.length > 0 ? (
                        `${r.approvedSources.length} listed`
                      ) : (
                        <span className="text-muted">None</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <DueCell date={r.returnBy} days={days} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted">{shortDate(r.posted)}</td>
                    <td className="px-3 py-2.5">
                      <a
                        href={dibbsSolicitationUrl(r.solicitation)}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-muted hover:text-accent"
                        title="Open on DIBBS"
                        aria-label={`Open ${r.solicitation} on DIBBS`}
                      >
                        <ExternalIcon />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="px-6 py-16 text-center text-sm text-muted">
                No solicitations match these filters.
              </div>
            )}
          </div>

          {pageCount > 1 && (
            <div className="flex items-center justify-between px-4 py-3 text-sm lg:px-6">
              <span className="text-muted tabular-nums">
                {(page * PAGE_SIZE + 1).toLocaleString()}–
                {Math.min((page + 1) * PAGE_SIZE, filtered.length).toLocaleString()} of{" "}
                {filtered.length.toLocaleString()}
              </span>
              <div className="flex gap-1">
                <button
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                  className="rounded-md border border-line bg-panel px-3 py-1 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  disabled={page >= pageCount - 1}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-md border border-line bg-panel px-3 py-1 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </main>
      </div>

      {selected && (
        <DetailPanel
          rfq={selected}
          today={today}
          fscName={data.fscNames[selected.fsc]}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function FilterGroup({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 border-b border-line pb-5 last:border-0">
      <h3 className="mb-2 text-sm font-medium" title={hint}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
  count,
  title,
}: {
  checked: boolean;
  onChange: () => void;
  label: React.ReactNode;
  count: number;
  title?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 py-1 text-sm" title={title}>
      <span className="flex min-w-0 items-center gap-2">
        <input type="checkbox" checked={checked} onChange={onChange} className="shrink-0" />
        {label}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted">{count.toLocaleString()}</span>
    </label>
  );
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  align,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (k: SortKey) => void;
  align?: "right";
}) {
  const active = sort.key === k;
  return (
    <th className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : ""}`}>
      <button onClick={() => onSort(k)} className={`hover:text-foreground ${active ? "text-foreground" : ""}`}>
        {label} {active ? (sort.dir === 1 ? "↑" : "↓") : ""}
      </button>
    </th>
  );
}

function SetAsideBadge({ code }: { code: string }) {
  const info = SET_ASIDES[code];
  if (code === "N") return <span className="text-xs text-muted">Unrestricted</span>;
  return (
    <span
      className="whitespace-nowrap rounded bg-ok-soft px-1.5 py-0.5 text-xs font-medium text-ok"
      title={info?.label}
    >
      {info?.short ?? code}
    </span>
  );
}

function DueCell({ date, days }: { date: string; days: number }) {
  const tone =
    days < 0 ? "bg-subtle text-muted" : days <= 3 ? "bg-danger-soft text-danger" : days <= 7 ? "bg-warn-soft text-warn" : "";
  const label = days < 0 ? "closed" : days === 0 ? "today" : days === 1 ? "tomorrow" : `${days}d`;
  return (
    <span className="flex items-center gap-2">
      <span className="tabular-nums">{shortDate(date)}</span>
      <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone || "text-muted"}`}>{label}</span>
    </span>
  );
}

function DetailPanel({
  rfq: r,
  today,
  fscName,
  onClose,
}: {
  rfq: Rfq;
  today: string;
  fscName?: string;
  onClose: () => void;
}) {
  const days = daysUntil(r.returnBy, today);
  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-line bg-panel shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-line p-5">
          <div className="min-w-0">
            <p className="font-mono text-sm text-muted">{r.solicitation}</p>
            <h2 className="mt-1 text-lg font-semibold leading-snug">{r.nomenclature}</h2>
            <p className="mt-1 font-mono text-sm">{formatNsn(r.nsn)}</p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-subtle" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="mb-5 flex gap-2">
            <a
              href={dibbsSolicitationUrl(r.solicitation)}
              target="_blank"
              rel="noreferrer"
              className="flex flex-1 items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white dark:text-black"
            >
              Open on DIBBS <ExternalIcon />
            </a>
            {r.itemType === "nsn" && (
              <a
                href={dibbsNsnUrl(r.nsn)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-2 rounded-md border border-line px-3 py-2 text-sm"
                title="All open DIBBS RFQs for this NSN"
              >
                Other RFQs for NSN
              </a>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Field label="Return by">
              {shortDate(r.returnBy)}{" "}
              <span className={days >= 0 && days <= 3 ? "text-danger" : "text-muted"}>
                ({days < 0 ? "closed" : days === 0 ? "today" : `${days} days`})
              </span>
            </Field>
            <Field label="Posted">{shortDate(r.posted)}</Field>
            <Field label="Quantity">
              {r.qty.toLocaleString()} {r.unit}
            </Field>
            <Field label="Set-aside">
              {SET_ASIDES[r.setAside]?.label ?? r.setAside}
              {r.setAside !== "N" && r.setAsidePct > 0 && r.setAsidePct < 100 && ` (${r.setAsidePct}%)`}
            </Field>
            <Field label="Category (FSC)" wide>
              <span className="font-mono">{r.fsc}</span> {fscName}
            </Field>
            <Field label="AMSC">{r.amsc || "—"}</Field>
            <Field label="Purchase request">
              <span className="font-mono">{r.purchaseRequest}</span>
            </Field>
            <Field label="Buyer code">
              <span className="font-mono">{r.buyerCode}</span>
            </Field>
          </dl>

          <h3 className="mb-2 mt-6 text-sm font-medium">
            Approved sources <span className="text-muted">({r.approvedSources.length})</span>
          </h3>
          {r.approvedSources.length === 0 ? (
            <p className="text-sm text-muted">No approved sources listed for this item.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1 font-medium">CAGE</th>
                  <th className="py-1 font-medium">Part number</th>
                </tr>
              </thead>
              <tbody>
                {r.approvedSources.map((s, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="py-1.5 font-mono">{s.cage}</td>
                    <td className="py-1.5 font-mono">
                      {s.partNumber}
                      {s.company && <div className="font-sans text-xs text-muted">{s.company}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </aside>
    </>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? "col-span-2" : ""}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function ExternalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M9 3h4v4M13 3L7 9M11 9.5V13H3V5h3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
