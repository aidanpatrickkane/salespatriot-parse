// Shape of data/rfqs.json, written by scripts/ingest.mts.

export type ApprovedSource = { cage: string; partNumber: string; company: string };

export type Rfq = {
  id: string;
  solicitation: string;
  solType: string;
  nsn: string;
  itemType: "nsn" | "part";
  fsc: string;
  purchaseRequest: string;
  returnBy: string; // YYYY-MM-DD
  posted: string; // YYYY-MM-DD
  qty: number;
  unit: string;
  nomenclature: string;
  buyerCode: string;
  amsc: string;
  setAside: string;
  setAsidePct: number;
  approvedSources: ApprovedSource[];
};

export type RfqData = {
  syncedAt: string;
  dates: string[];
  fscNames: Record<string, string>;
  rfqs: Rfq[];
};

// Codes from dibbs.bsm.dla.mil/Rfq/RfqFileDefs.aspx
export const SET_ASIDES: Record<string, { label: string; short: string }> = {
  N: { label: "Unrestricted", short: "Open" },
  Y: { label: "Small Business", short: "SB" },
  H: { label: "HUBZone", short: "HUBZone" },
  R: { label: "Service-Disabled Veteran-Owned", short: "SDVOSB" },
  L: { label: "Woman-Owned Small Business", short: "WOSB" },
  E: { label: "Economically Disadvantaged WOSB", short: "EDWOSB" },
  A: { label: "8(a)", short: "8(a)" },
};

export function formatNsn(nsn: string) {
  return /^\d{13}$/.test(nsn) ? `${nsn.slice(0, 4)}-${nsn.slice(4, 6)}-${nsn.slice(6, 9)}-${nsn.slice(9)}` : nsn;
}

export function dibbsSolicitationUrl(solicitation: string) {
  return `https://www.dibbs.bsm.dla.mil/rfq/rfqrec.aspx?sn=${encodeURIComponent(solicitation)}`;
}

export function dibbsNsnUrl(nsn: string) {
  return `https://www.dibbs.bsm.dla.mil/RFQ/RFQNsn.aspx?value=${encodeURIComponent(nsn)}`;
}

/** Whole days from `today` to `date`, both YYYY-MM-DD. */
export function daysUntil(date: string, today: string) {
  return Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
}
