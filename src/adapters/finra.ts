import * as cheerio from "cheerio";
import type { NormalizedAction, Provenance } from "../types.js";
import { classifyActionType } from "../normalization/actionTypes.js";
import { classifyStatus } from "../normalization/status.js";
import { normalizeDate } from "../normalization/dates.js";
import { extractPenalty } from "../normalization/penalties.js";
import { normalizeEntityKey } from "../normalization/entities.js";
import {
  fetchText,
  type AdapterRunResult,
  type AgencyAdapter,
} from "./base.js";

/**
 * FINRA adapter.
 *
 * FINRA replaced its per-month summary pages with a single consolidated
 * disciplinary-actions table at
 *   https://www.finra.org/rules-guidance/oversight-enforcement/finra-disciplinary-actions
 * The table has 5 columns:
 *   1. case_number            — FINRA internal ID (e.g. 2025087193401)
 *   2. description            — narrative of the allegation or finding
 *   3. action_type            — FINRA's own taxonomy (Complaints, Orders
 *                               Accepting Offers of Settlement, AWC, etc.)
 *   4. respondent             — firm or individual name
 *   5. date                   — MM/DD/YYYY publication date
 *
 * Each case row also carries a detail URL at
 *   /rules-guidance/oversight-enforcement/finra-disciplinary-actions?search=<case_number>
 *
 * Parsing strategy is defensive — when the table layout changes we record a
 * `partial` ingestion run with a hint but do NOT crash.
 */

const FINRA_LANDING =
  "https://www.finra.org/rules-guidance/oversight-enforcement/finra-disciplinary-actions";

const FINRA_ROW_CASE_URL =
  "https://www.finra.org/rules-guidance/oversight-enforcement/finra-disciplinary-actions?search=";

/**
 * Number of paginated pages of the disciplinary-actions table to ingest.
 * Each page holds 15 rows. FINRA's WAF rate-limits rapid sequential
 * requests from the same IP (observed 403 after ~5 page loads without
 * delay). With a 2-second delay between pages we can safely ingest
 * ~25 pages ≈ 375 actions on each cron run before risk of the WAF
 * flagging us. Override via FINRA_HISTORY_PAGES env var for deeper or
 * shallower backfill.
 */
const FINRA_HISTORY_PAGES = (() => {
  const raw = Number(process.env.FINRA_HISTORY_PAGES);
  if (Number.isFinite(raw) && raw > 0 && raw <= 300) return Math.trunc(raw);
  return 25;
})();

export class FINRAAdapter implements AgencyAdapter {
  readonly agency = "FINRA" as const;
  readonly runTimeoutMs = 300_000;

  async fetchRecent(): Promise<AdapterRunResult> {
    const errors: AdapterRunResult["errors"] = [];
    const actions: NormalizedAction[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < FINRA_HISTORY_PAGES; page += 1) {
      const url = page === 0 ? FINRA_LANDING : `${FINRA_LANDING}?page=${page}`;
      // Courtesy delay between pages — FINRA's WAF returns 403 on rapid
      // sequential requests from the same IP. 2s keeps us well below the
      // observed threshold while still completing 25 pages in ~60 seconds.
      if (page > 0) await new Promise((r) => setTimeout(r, 2000));
      let html: string;
      try {
        html = await fetchText(url, 20_000);
      } catch (err) {
        errors.push({
          message: `FINRA page ${page} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        // Stop paginating if a page fails — avoids cascading errors.
        break;
      }
      const $ = cheerio.load(html);
      let rowsOnPage = 0;
      $("table tr").each((_, tr) => {
        const cells = $(tr).find("td");
        if (cells.length < 4) return;

        const caseNumber = cells.eq(0).text().trim();
        const description = cells.eq(1).text().trim();
        const rawActionType = cells.eq(2).text().trim();
        const respondent = cells.eq(3).text().trim();
        const dateText = cells.length >= 5 ? cells.eq(4).text().trim() : "";

        if (!caseNumber || !respondent) return;
        if (caseNumber.toLowerCase() === "case number") return; // header row

        const action = buildAction({
          caseNumber,
          description,
          rawActionType,
          respondent,
          dateText,
        });
        if (action && !seen.has(action.actionId)) {
          seen.add(action.actionId);
          actions.push(action);
          rowsOnPage += 1;
        }
      });
      // A page with no new rows usually means we've paginated past the end.
      if (rowsOnPage === 0) break;
    }

    if (actions.length === 0) {
      errors.push({
        message: "FINRA paginated listing yielded no table rows",
        hint: `FINRA may have changed the disciplinary-actions layout. Inspect ${FINRA_LANDING} and update table selectors in src/adapters/finra.ts.`,
      });
    }

    return { agency: "FINRA", sourceUrl: FINRA_LANDING, actions, errors };
  }
}

function buildAction(row: {
  caseNumber: string;
  description: string;
  rawActionType: string;
  respondent: string;
  dateText: string;
}): NormalizedAction | null {
  const actionId = `FINRA:${sanitizeId(row.caseNumber)}`;
  const actionDate = normalizeDate(row.dateText);
  const actionType = classifyActionType("FINRA", row.rawActionType, [
    row.description,
    row.rawActionType,
  ]);
  const status = classifyStatus([row.rawActionType, row.description]);
  const penalty = extractPenalty([row.description, row.rawActionType].filter(Boolean).join(" "));
  const documentUrl = `${FINRA_ROW_CASE_URL}${encodeURIComponent(row.caseNumber)}`;

  const provenance: Provenance = {
    source: "FINRA-disciplinary-actions-table",
    sourceUrl: FINRA_LANDING,
    fetchedAt: new Date().toISOString(),
    fieldOrigin: {
      agency: "observed",
      actionId: "observed",
      actionType: "normalized",
      rawActionType: "observed",
      status: "normalized",
      respondent: "observed",
      actionDate: actionDate ? "observed" : "unknown",
      title: "observed",
      summary: "observed",
      allegations: "observed",
      penaltyAmount: penalty.origin,
      documentUrl: "observed",
    },
  };

  return {
    actionId,
    agency: "FINRA",
    actionType,
    rawActionType: row.rawActionType,
    status,
    actionDate,
    respondent: row.respondent.slice(0, 255),
    respondents: [row.respondent],
    penaltyAmount: penalty.amount,
    penaltyCurrency: "USD",
    penaltyBreakdown: penalty.breakdown,
    title: `${row.rawActionType}: ${row.respondent}`.slice(0, 255),
    summary: row.description.slice(0, 2000),
    allegations: row.description,
    documentUrl,
    entityKey: normalizeEntityKey(row.respondent),
    provenance,
    rawPayload: row,
  };
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 180);
}
