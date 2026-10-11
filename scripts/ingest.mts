// Pulls the most recent DIBBS RFQ daily files and writes them to data/rfqs.json.
//
// Usage: npm run ingest [-- --days 3]
//
// DIBBS puts a "DoD Warning and Consent" page in front of every host
// (www.dibbs.bsm.dla.mil and dibbs2.bsm.dla.mil separately). We accept it once
// per host by posting the form back, then keep the session cookies.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";

const WWW = "https://www.dibbs.bsm.dla.mil";
const FILES = "https://dibbs2.bsm.dla.mil/Downloads/RFQ/Archive";
const OUT = path.join(process.cwd(), "data", "rfqs.json");

const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 3;

// ---------- tiny cookie-aware HTTP client ----------

const jar = new Map<string, Map<string, string>>(); // host -> name -> value

function cookieHeader(url: URL) {
  const cookies = jar.get(url.host);
  if (!cookies) return "";
  return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeCookies(url: URL, res: Response) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (!jar.has(url.host)) jar.set(url.host, new Map());
    jar.get(url.host)!.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function request(input: string, init: RequestInit = {}): Promise<{ url: URL; res: Response }> {
  let url = new URL(input);
  let method = init.method ?? "GET";
  let body = init.body;
  for (let hop = 0; hop < 10; hop++) {
    const res = await fetch(url, {
      method,
      body,
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (solicitation-browser ingest)",
        Cookie: cookieHeader(url),
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
    });
    storeCookies(url, res);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      method = "GET";
      body = undefined;
      continue;
    }
    return { url, res };
  }
  throw new Error(`Too many redirects for ${input}`);
}

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** GET a URL, clicking through the DoD consent page if the host serves it. */
async function get(target: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { url, res } = await request(target);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${target}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const isConsent =
      (res.headers.get("content-type") ?? "").includes("text/html") &&
      buf.toString("latin1").includes("DoD) Warning and Consent");
    if (!isConsent) return buf;

    const page = buf.toString("latin1");
    const action = page.match(/<form[^>]*action="([^"]*)"/)?.[1];
    if (!action) throw new Error("Consent page had no form");
    const form = new URLSearchParams();
    for (const m of page.matchAll(/<input type="hidden" name="([^"]+)"[^>]*value="([^"]*)"/g)) {
      form.set(m[1], decodeEntities(m[2]));
    }
    form.set("butAgree", "OK");
    const { res: posted } = await request(new URL(decodeEntities(action), url).toString(), {
      method: "POST",
      body: form.toString(),
    });
    const postedBuf = Buffer.from(await posted.arrayBuffer());
    // The consent POST usually redirects straight to the target file.
    if (posted.ok && !postedBuf.toString("latin1").includes("DoD) Warning and Consent")) {
      return postedBuf;
    }
  }
  throw new Error(`Could not get past DoD consent page for ${target}`);
}

// ---------- parsing ----------

type ApprovedSource = { cage: string; partNumber: string; company: string };

export type Rfq = {
  id: string;
  solicitation: string;
  solType: string; // 9th char of solicitation number (T / Q / U ...)
  nsn: string; // 13-digit NSN, or part number when itemType = "part"
  itemType: "nsn" | "part";
  fsc: string;
  purchaseRequest: string;
  returnBy: string; // YYYY-MM-DD
  posted: string; // YYYY-MM-DD (date of the daily file)
  qty: number;
  unit: string;
  nomenclature: string;
  buyerCode: string;
  amsc: string;
  setAside: string;
  setAsidePct: number;
  approvedSources: ApprovedSource[];
};

/** "in" file: fixed-width, layout from dibbs.bsm.dla.mil/Rfq/RfqFileDefs.aspx */
function parseIndex(text: string, posted: string): Omit<Rfq, "approvedSources" | "fsc">[] {
  const rows: Omit<Rfq, "approvedSources" | "fsc">[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    const line = raw.padEnd(140);
    const f = (start: number, len: number) => line.slice(start, start + len).trim();
    const solicitation = f(0, 13);
    const [mm, dd, yy] = f(72, 8).split("/");
    const itemType = f(135, 1) === "2" ? "part" : "nsn";
    rows.push({
      id: `${solicitation}-${f(59, 13)}`,
      solicitation,
      solType: solicitation.charAt(8),
      nsn: f(13, 46),
      itemType,
      purchaseRequest: f(59, 13),
      returnBy: `20${yy}-${mm}-${dd}`,
      posted,
      qty: Number(f(99, 7)) || 0,
      unit: f(106, 2),
      nomenclature: f(108, 21).replace(/,$/, ""),
      buyerCode: f(129, 5),
      amsc: f(134, 1),
      setAside: f(136, 1) || "N",
      setAsidePct: Number(f(137, 3)) || 0,
    });
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** "as" file inside the bq zip: NSN, CAGE, part number, company name */
function parseApprovedSources(text: string) {
  const byNsn = new Map<string, ApprovedSource[]>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [nsn, cage, partNumber, company] = parseCsvLine(line).map((s) => s.trim());
    if (!nsn) continue;
    if (!byNsn.has(nsn)) byNsn.set(nsn, []);
    byNsn.get(nsn)!.push({ cage, partNumber, company: company ?? "" });
  }
  return byNsn;
}

async function getFscNames(): Promise<Record<string, string>> {
  const html = (await get(`${WWW}/Rfq/RfqFsc.aspx`)).toString("latin1");
  const names: Record<string, string> = {};
  for (const m of html.matchAll(/<option[^>]*value="(\d{4})\*?"[^>]*>\s*\d{4}\s*-\s*([^<]+)</g)) {
    names[m[1]] = decodeEntities(m[2]).trim();
  }
  return names;
}

async function getRecentDates(): Promise<string[]> {
  const html = (await get(`${WWW}/Rfq/RfqDates.aspx?category=recent`)).toString("latin1");
  const codes = [...html.matchAll(/Archive\/in(\d{6})\.txt/gi)].map((m) => m[1]);
  return [...new Set(codes)].sort().reverse(); // YYMMDD, newest first
}

// ---------- main ----------

async function main() {
  console.log(`Fetching list of recent RFQ dates…`);
  const dates = (await getRecentDates()).slice(0, DAYS);
  if (dates.length === 0) throw new Error("No RFQ dates found on DIBBS");
  console.log(`Ingesting ${dates.join(", ")}`);

  const [fscNames, ...perDay] = await Promise.all([
    getFscNames().catch((err) => {
      console.warn(`Could not load FSC names: ${err.message}`);
      return {} as Record<string, string>;
    }),
    ...dates.map(async (code) => {
      const posted = `20${code.slice(0, 2)}-${code.slice(2, 4)}-${code.slice(4, 6)}`;
      const [index, bq] = await Promise.all([get(`${FILES}/in${code}.txt`), get(`${FILES}/bq${code}.zip`)]);
      const rows = parseIndex(index.toString("latin1"), posted);
      const zip = unzipSync(new Uint8Array(bq));
      const asName = Object.keys(zip).find((n) => n.toLowerCase().startsWith("as"));
      const sources = asName ? parseApprovedSources(strFromU8(zip[asName], true)) : new Map();
      console.log(`  ${posted}: ${rows.length} line items, ${sources.size} NSNs with approved sources`);
      return rows.map((r) => ({
        ...r,
        fsc: /^\d{4}/.test(r.nsn) ? r.nsn.slice(0, 4) : "",
        approvedSources: sources.get(r.nsn) ?? [],
      }));
    }),
  ]);

  // The same line item can show up on more than one day; keep the newest.
  const byId = new Map<string, Rfq>();
  for (const day of perDay) for (const r of day) if (!byId.has(r.id)) byId.set(r.id, r);
  const rfqs = [...byId.values()];

  const usedFscs = new Set(rfqs.map((r) => r.fsc).filter(Boolean));
  const data = {
    syncedAt: new Date().toISOString(),
    dates: dates.map((c) => `20${c.slice(0, 2)}-${c.slice(2, 4)}-${c.slice(4, 6)}`),
    fscNames: Object.fromEntries(Object.entries(fscNames).filter(([k]) => usedFscs.has(k))),
    rfqs,
  };
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data));
  console.log(`Wrote ${rfqs.length} line items to ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
