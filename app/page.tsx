import { readFile } from "node:fs/promises";
import path from "node:path";
import { Suspense } from "react";
import { connection } from "next/server";
import type { RfqData } from "@/lib/rfq";
import { SolicitationBrowser } from "./solicitation-browser";

async function loadData(): Promise<RfqData | null> {
  await connection();
  try {
    return JSON.parse(await readFile(path.join(process.cwd(), "data", "rfqs.json"), "utf8"));
  } catch {
    return null;
  }
}

function localDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeAgo(iso: string) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function Browser() {
  const data = await loadData();
  if (!data) {
    return (
      <div className="mx-auto mt-24 max-w-md rounded-lg border border-line bg-panel p-6 text-sm">
        <p className="font-medium">No data yet.</p>
        <p className="mt-2 text-muted">
          Run <code className="rounded bg-subtle px-1.5 py-0.5 font-mono">npm run ingest</code> to pull the latest
          RFQs from DIBBS, then reload.
        </p>
      </div>
    );
  }
  return <SolicitationBrowser data={data} today={localDate(new Date())} syncedLabel={timeAgo(data.syncedAt)} />;
}

export default function Page() {
  return (
    <Suspense
      fallback={<div className="flex flex-1 items-center justify-center text-sm text-muted">Loading solicitations…</div>}
    >
      <Browser />
    </Suspense>
  );
}
