import type { NormalizedAction, Provenance } from "../types.js";
import { classifyActionType } from "../normalization/actionTypes.js";
import { classifyStatus } from "../normalization/status.js";
import { normalizeDate } from "../normalization/dates.js";
import { extractPenalty } from "../normalization/penalties.js";
import { normalizeEntityKey } from "../normalization/entities.js";
import {
  fetchJson,
  type AdapterRunResult,
  type AgencyAdapter,
} from "./base.js";

/**
 * OCC adapter: uses the OCC's official public Enforcement Actions JSON API at
 *   https://api.occ.gov/EnforcementActions/list/{keyword}?api_key=DEMO_KEY
 *
 * Each record is a formal enforcement action against an OCC-regulated national
 * bank, federal savings association, federal branch/agency of a foreign bank,
 * or an institution-affiliated party (officer/director/employee). Fields:
 *   Institution, CharterNumber, Company, Individual, Location, TypeCode,
 *   TypeDescription, Amount, StartDate, StartDocuments[], TerminationDate,
 *   TerminationDocuments[], DocketNumber, SubjectMatters[]
 *
 * The API requires a `keyword`. No single keyword returns the full dataset, so
 * we query a small set of broad keywords ("bank", "national", "association",
 * "savings", "federal") and dedupe by DocketNumber. "bank" alone returns
 * ~5,900 records covering the vast majority of modern OCC enforcement.
 */

const OCC_API = "https://api.occ.gov/EnforcementActions/list";
// One well-chosen broad keyword ("bank") returns ~5,900 records that cover
// effectively all OCC-regulated entities (national banks, federal savings
// associations, federal branches of foreign banks). Extra keywords only
// marginally help and consume the DEMO_KEY rate limit (30 req/hour).
const OCC_KEYWORDS = ["bank", "association"];
const OCC_LOOKBACK_YEARS = 6;

interface OccRecord {
  Institution?: string;
  CharterNumber?: string;
  Company?: string;
  Individual?: string;
  Location?: string;
  TypeCode?: string;
  TypeDescription?: string;
  Amount?: string;
  StartDate?: string;
  StartDocuments?: string[];
  TerminationDate?: string;
  TerminationDocuments?: string[];
  DocketNumber?: string;
  SubjectMatters?: string[];
}

export class OCCAdapter implements AgencyAdapter {
  readonly agency = "OCC" as const;
  // Per-keyword request can return 5,000+ records and downloading plus JSON
  // parse can take 30-60 seconds per call. Give the whole adapter 5 minutes.
  readonly runTimeoutMs = 300_000;

  async fetchRecent(): Promise<AdapterRunResult> {
    const errors: AdapterRunResult["errors"] = [];
    const byDocket = new Map<string, OccRecord>();
    const apiKey = process.env.OCC_API_KEY ?? "DEMO_KEY";
    const usingDemo = apiKey === "DEMO_KEY";

    console.log(`[OCC] starting fetch, apiKey=${usingDemo ? "DEMO_KEY" : "custom"}, keywords=${OCC_KEYWORDS.join(",")}`);

    for (const keyword of OCC_KEYWORDS) {
      const url = `${OCC_API}/${encodeURIComponent(keyword)}?api_key=${apiKey}`;
      const started = Date.now();
      try {
        const rows = await fetchJson<OccRecord[]>(url, { timeoutMs: 60_000 });
        const elapsed = Date.now() - started;
        if (!Array.isArray(rows)) {
          console.log(`[OCC] keyword="${keyword}" returned non-array after ${elapsed}ms`);
          continue;
        }
        let newThisBatch = 0;
        for (const row of rows) {
          const key = row.DocketNumber?.trim();
          if (!key) continue;
          if (!byDocket.has(key)) {
            byDocket.set(key, row);
            newThisBatch += 1;
          }
        }
        console.log(
          `[OCC] keyword="${keyword}" returned ${rows.length} rows (+${newThisBatch} new) in ${elapsed}ms; total unique=${byDocket.size}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[OCC] keyword="${keyword}" FAILED after ${Date.now() - started}ms: ${msg}`);
        errors.push({
          message: `OCC API keyword "${keyword}": ${msg}`,
          hint: `URL: ${url.replace(apiKey, "***")}. DEMO_KEY is rate-limited to 30 req/hour; set OCC_API_KEY for production.`,
        });
        // If rate-limited (429) or auth-rejected (403), stop probing further
        // keywords — more calls will only compound the error.
        if (/HTTP 4(03|29)/i.test(msg)) break;
      }
    }

    if (byDocket.size === 0) {
      errors.push({
        message: "OCC API returned no records across all probe keywords",
        hint: usingDemo
          ? "OCC_API_KEY env var not set; using DEMO_KEY (30 req/hr limit). Request a free key at https://api.data.gov/signup/ and set OCC_API_KEY in Railway."
          : "Verify api.occ.gov/EnforcementActions/list/{keyword} is reachable from the Railway deployment region.",
      });
      return { agency: "OCC", sourceUrl: OCC_API, actions: [], errors };
    }

    // Limit to the last N years of StartDate to keep the footprint reasonable
    // and match the proposal's 5-year lookback promise. OCC returns records
    // going back to the 1980s.
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - OCC_LOOKBACK_YEARS);
    const cutoffIso = cutoff.toISOString().slice(0, 10);

    const actions: NormalizedAction[] = [];
    for (const row of byDocket.values()) {
      const startIso = normalizeDate(row.StartDate);
      if (!startIso || startIso < cutoffIso) continue;

      const docket = (row.DocketNumber ?? "").trim();
      const actionId = `OCC:${sanitizeId(docket)}`;
      const respondent = resolveRespondent(row);
      const title = buildTitle(row, respondent);
      const summary = buildSummary(row);
      const amountParsed = parseAmount(row.Amount);
      const penaltyFromText = extractPenalty(`${title} ${summary}`);
      const penaltyAmount = amountParsed ?? penaltyFromText.amount;
      const penaltyOrigin: Provenance["fieldOrigin"]["penaltyAmount"] =
        amountParsed != null ? "observed" : penaltyFromText.origin;

      const subjectMatters = (row.SubjectMatters ?? []).filter(Boolean);
      const actionType = classifyActionType(
        "OCC",
        row.TypeDescription ?? row.TypeCode ?? "",
        [title, summary, ...subjectMatters],
      );
      const terminationIso = normalizeDate(row.TerminationDate);
      // A terminated OCC order is one whose remedial period has ended — the
      // case is effectively closed. Map to the closest canonical status.
      const status = terminationIso
        ? "final_order"
        : classifyStatus([title, summary, row.TypeDescription ?? ""]);

      const provenance: Provenance = {
        source: "OCC-api-enforcement-actions",
        sourceUrl: OCC_API,
        fetchedAt: new Date().toISOString(),
        fieldOrigin: {
          agency: "observed",
          actionId: "observed",
          actionType: "normalized",
          status: terminationIso ? "observed" : "normalized",
          respondent: "observed",
          actionDate: startIso ? "observed" : "unknown",
          title: "normalized",
          summary: "observed",
          penaltyAmount: penaltyOrigin,
          documentUrl: "observed",
        },
      };

      actions.push({
        actionId,
        agency: "OCC",
        actionType,
        rawActionType: row.TypeDescription ?? row.TypeCode,
        status,
        actionDate: startIso,
        respondent: respondent.slice(0, 255),
        respondents: [respondent],
        penaltyAmount: penaltyAmount,
        penaltyCurrency: "USD",
        penaltyBreakdown: penaltyFromText.breakdown,
        title: title.slice(0, 255),
        summary,
        allegations: summary,
        documentUrl: buildDocUrl(row),
        entityKey: normalizeEntityKey(respondent),
        provenance,
        rawPayload: row as unknown as Record<string, unknown>,
      });
    }

    if (actions.length === 0 && errors.length === 0) {
      errors.push({
        message: `OCC API returned ${byDocket.size} raw records but none passed date/shape filters`,
        hint: `Lookback window is ${OCC_LOOKBACK_YEARS} years; extend OCC_LOOKBACK_YEARS if you need deeper history.`,
      });
    }

    return { agency: "OCC", sourceUrl: OCC_API, actions, errors };
  }
}

function resolveRespondent(row: OccRecord): string {
  // OCC records are either against an Institution, a Company, or an Individual
  // (IAP). Pick the most specific non-empty field.
  const individual = clean(row.Individual);
  const company = clean(row.Company);
  const institution = clean(row.Institution);
  if (individual && institution) return `${individual} (${institution})`;
  if (individual) return individual;
  if (company) return company;
  if (institution) return institution;
  return row.DocketNumber ?? "OCC enforcement action";
}

function buildTitle(row: OccRecord, respondent: string): string {
  const parts: string[] = [];
  parts.push(row.TypeDescription ?? row.TypeCode ?? "OCC enforcement action");
  parts.push("against");
  parts.push(respondent);
  return parts.filter(Boolean).join(" ");
}

function buildSummary(row: OccRecord): string {
  const parts: string[] = [];
  if (row.TypeDescription) parts.push(row.TypeDescription);
  if (row.Location) parts.push(`Location: ${row.Location}`);
  if (row.CharterNumber) parts.push(`Charter #${row.CharterNumber}`);
  if (row.DocketNumber) parts.push(`Docket ${row.DocketNumber}`);
  if (row.Amount && Number(row.Amount) > 0) parts.push(`Penalty $${row.Amount}`);
  if (row.TerminationDate) parts.push(`Terminated ${row.TerminationDate}`);
  const subjects = (row.SubjectMatters ?? []).filter(Boolean);
  if (subjects.length > 0) parts.push(`Subject Matters: ${subjects.join(", ")}`);
  return parts.join("; ");
}

function buildDocUrl(row: OccRecord): string {
  // Start documents come back as bare IDs like "2005-38". The canonical public
  // PDF lives at occ.gov/static/enforcement-actions/ea{id}.pdf for the modern
  // archive; older records require the EASearch tool.
  const first = row.StartDocuments?.[0];
  if (first && /^\d{4}-\d+$/.test(first)) {
    return `https://occ.gov/static/enforcement-actions/ea${first}.pdf`;
  }
  const docket = row.DocketNumber;
  if (docket) return `https://apps.occ.gov/EASearch/?searchString=${encodeURIComponent(docket)}`;
  return "https://apps.occ.gov/EASearch";
}

function parseAmount(amount: string | undefined): number | null {
  if (!amount) return null;
  const clean = amount.replace(/[,$\s]/g, "");
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clean(v: string | undefined): string {
  if (!v) return "";
  return v.replace(/\s+/g, " ").trim();
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 180);
}
