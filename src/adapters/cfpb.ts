import * as cheerio from "cheerio";
import type {
  NormalizedAction,
  Provenance,
} from "../types.js";
import { classifyActionType } from "../normalization/actionTypes.js";
import { classifyStatus } from "../normalization/status.js";
import { normalizeDate } from "../normalization/dates.js";
import {
  extractPenalty,
  parsePenaltyAmount,
} from "../normalization/penalties.js";
import { normalizeEntityKey } from "../normalization/entities.js";
import {
  fetchJson,
  fetchText,
  type AdapterRunResult,
  type AgencyAdapter,
} from "./base.js";

/**
 * CFPB adapter.
 *
 * CFPB retired its public Socrata enforcement-actions dataset sometime in
 * 2025. The canonical public source is now the HTML listing at
 *   https://www.consumerfinance.gov/enforcement/actions/
 * which paginates all public enforcement actions back to 2012. Each row
 * carries the respondent, filing date, action type, and links to a detail
 * page with the full press release and order PDF.
 *
 * We parse the HTML listing by default and fall back to any Socrata dataset
 * that still responds — multiple dataset IDs have been used historically.
 */

const HTML_INDEX = "https://www.consumerfinance.gov/enforcement/actions/";
const CFPB_MAX_PAGES = (() => {
  const raw = Number(process.env.CFPB_HISTORY_PAGES);
  if (Number.isFinite(raw) && raw > 0 && raw <= 50) return Math.trunc(raw);
  return 20;
})();
const HTML_INDEX_PAGES = Array.from({ length: CFPB_MAX_PAGES }, (_, i) =>
  i === 0 ? HTML_INDEX : `${HTML_INDEX}?page=${i + 1}`,
);

// Candidate Socrata dataset IDs we've seen over time. We try them in order;
// any that return a JSON array are used. If all fail we fall back to HTML.
const SOCRATA_CANDIDATES = [
  "https://data.consumerfinance.gov/resource/sjn8-e27p.json?$limit=500",
  "https://data.consumerfinance.gov/resource/y6mt-r5kq.json?$limit=500",
  "https://data.consumerfinance.gov/resource/jdvk-qcwc.json?$limit=500",
];

interface SocrataRow {
  case_id?: string;
  name?: string;
  respondent?: string;
  institution?: string;
  docket_number?: string;
  status?: string;
  final_disposition?: string;
  action?: string;
  action_type?: string;
  final_disposition_date?: string;
  date?: string;
  civil_money_penalty_amount?: string;
  consumer_redress_amount?: string;
  disgorgement_amount?: string;
  total_monetary_relief?: string;
  summary?: string;
  document_url?: string;
  url?: string;
  press_release_url?: string;
}

export class CFPBAdapter implements AgencyAdapter {
  readonly agency = "CFPB" as const;
  readonly runTimeoutMs = 60_000;

  async fetchRecent(): Promise<AdapterRunResult> {
    const errors: AdapterRunResult["errors"] = [];

    // --- Primary source: HTML listing at /enforcement/actions/. ---
    // CFPB retired the public Socrata dataset, so HTML is now the canonical
    // source. We only fall back to Socrata if HTML fails or returns nothing.
    const actions: NormalizedAction[] = [];
    const seen = new Set<string>();
    const htmlErrors: AdapterRunResult["errors"] = [];
    for (const page of HTML_INDEX_PAGES) {
      try {
        const html = await fetchText(page, 20_000);
        const parsed = parseHtmlListing(html, page);
        let newThisPage = 0;
        for (const a of parsed) {
          if (!seen.has(a.actionId)) {
            seen.add(a.actionId);
            actions.push(a);
            newThisPage += 1;
          }
        }
        // Stop paginating once we hit a page with no new entries — we've
        // reached the end of the archive. This avoids hammering the server
        // for pages that don't exist.
        if (newThisPage === 0 && actions.length > 0) break;
      } catch (err) {
        htmlErrors.push({
          message: `CFPB HTML fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          hint: `URL: ${page}. If this URL is being blocked at the edge, verify outbound IP reputation; the listing is public.`,
        });
        // Stop paginating on error to avoid cascading failures.
        break;
      }
    }

    if (actions.length > 0) {
      // Primary succeeded. Don't pollute status with dead-dataset errors.
      return { agency: "CFPB", sourceUrl: HTML_INDEX, actions, errors };
    }

    // --- Fallback: Socrata (historically our primary; now usually dead). ---
    errors.push(...htmlErrors);
    for (const url of SOCRATA_CANDIDATES) {
      try {
        const rows = await fetchJson<SocrataRow[]>(url, { timeoutMs: 15_000 });
        if (Array.isArray(rows) && rows.length > 0) {
          const socrataActions = rows
            .map((r) => this.normalizeSocrataRow(r, url))
            .filter((a): a is NormalizedAction => Boolean(a));
          if (socrataActions.length > 0) {
            return { agency: "CFPB", sourceUrl: url, actions: socrataActions, errors };
          }
        }
      } catch (err) {
        errors.push({
          message: `CFPB Socrata ${url}: ${err instanceof Error ? err.message : String(err)}`,
          hint: "CFPB has retired multiple Socrata datasets; this is expected.",
        });
      }
    }

    if (errors.length === 0) {
      errors.push({
        message: "CFPB HTML listing yielded no rows",
        hint: `CFPB may have redesigned ${HTML_INDEX}; update selectors in src/adapters/cfpb.ts.`,
      });
    }

    return {
      agency: "CFPB",
      sourceUrl: HTML_INDEX,
      actions: [],
      errors,
    };
  }

  private normalizeSocrataRow(row: SocrataRow, sourceUrl: string): NormalizedAction | null {
    const respondent = row.respondent ?? row.name ?? row.institution ?? undefined;
    if (!respondent) return null;

    const id =
      row.case_id ??
      row.docket_number ??
      `${respondent}|${row.final_disposition_date ?? row.date ?? ""}`;
    const actionId = `CFPB:${sanitizeId(id)}`;

    const date = normalizeDate(row.final_disposition_date ?? row.date);
    const rawActionType = row.action_type ?? row.action ?? row.final_disposition ?? undefined;
    const actionType = classifyActionType("CFPB", rawActionType, [
      respondent,
      row.summary ?? "",
    ]);
    const status = classifyStatus([row.status ?? "", row.final_disposition ?? ""]);

    const cmp = parsePenaltyAmount(row.civil_money_penalty_amount);
    const redress = parsePenaltyAmount(row.consumer_redress_amount);
    const disgorge = parsePenaltyAmount(row.disgorgement_amount);
    const total = parsePenaltyAmount(row.total_monetary_relief);

    const breakdown: NormalizedAction["penaltyBreakdown"] = [];
    if (cmp) breakdown.push({ amount: cmp, currency: "USD", type: "civil_penalty" });
    if (redress) breakdown.push({ amount: redress, currency: "USD", type: "restitution" });
    if (disgorge) breakdown.push({ amount: disgorge, currency: "USD", type: "disgorgement" });

    let amount: number | undefined;
    let penaltyOrigin: "observed" | "inferred" | "unknown" = "unknown";
    if (breakdown.length > 0) {
      amount = breakdown.reduce((acc, c) => acc + c.amount, 0);
      penaltyOrigin = "observed";
    } else if (total) {
      amount = total;
      penaltyOrigin = "observed";
    } else if (row.summary) {
      const extracted = extractPenalty(row.summary);
      amount = extracted.amount;
      penaltyOrigin = extracted.origin;
      if (extracted.breakdown) breakdown.push(...extracted.breakdown);
    }

    const documentUrl = row.document_url ?? row.press_release_url ?? row.url ?? undefined;

    const provenance: Provenance = {
      source: "CFPB-Socrata",
      sourceUrl,
      fetchedAt: new Date().toISOString(),
      fieldOrigin: {
        agency: "observed",
        actionId: "observed",
        actionType: "normalized",
        rawActionType: rawActionType ? "observed" : "unknown",
        status: "normalized",
        respondent: "observed",
        actionDate: "normalized",
        penaltyAmount: penaltyOrigin,
        penaltyBreakdown: penaltyOrigin,
        allegations: row.summary ? "observed" : "unknown",
        documentUrl: documentUrl ? "observed" : "unknown",
      },
    };

    return {
      actionId,
      agency: "CFPB",
      actionType,
      rawActionType,
      status,
      rawStatus: row.status,
      actionDate: date,
      respondent,
      respondents: [respondent],
      penaltyAmount: amount,
      penaltyCurrency: "USD",
      penaltyBreakdown: breakdown.length > 0 ? breakdown : undefined,
      allegations: row.summary,
      title: row.name ?? respondent,
      summary: row.summary,
      documentUrl,
      entityKey: normalizeEntityKey(respondent),
      provenance,
      rawPayload: row,
    };
  }
}

/**
 * Parse the /enforcement/actions/ HTML listing. Each action on the listing is
 * rendered as a card/article with:
 *   - Respondent name + detail-page link (primary anchor)
 *   - Status tag (e.g. "Judgment entered", "Pending litigation")
 *   - Date filed
 *   - Optional description paragraph
 */
function parseHtmlListing(html: string, sourceUrl: string): NormalizedAction[] {
  const $ = cheerio.load(html);
  const actions: NormalizedAction[] = [];

  // CFPB uses both .m-list_item and article-style cards. We accept either.
  const rowSelector = [
    "article.o-post-preview",
    "li.m-list_item",
    "article",
    ".o-post-preview",
    ".m-list_item",
    ".a-post-preview",
  ].join(", ");

  $(rowSelector).each((_, el) => {
    const $el = $(el);
    const primary = $el.find("a").filter((_, a) => {
      const href = $(a).attr("href") ?? "";
      return /\/enforcement\/actions\/[\w-]+\/?$/.test(href);
    }).first();

    const href = primary.attr("href") ?? "";
    if (!href) return;
    const detailUrl = href.startsWith("http") ? href : `https://www.consumerfinance.gov${href}`;
    const respondent = primary.text().replace(/\s+/g, " ").trim();
    if (!respondent || respondent.length < 2) return;

    // Pull visible text for date/status/summary extraction.
    const fullText = $el.text().replace(/\s+/g, " ").trim();

    // Common patterns: "Date filed: 2024-10-15" / "Oct 15, 2024 · Civil penalty"
    const dateText =
      $el.find("time").attr("datetime") ||
      $el.find("time").first().text().trim() ||
      (/\b(\d{4}-\d{2}-\d{2})\b/.exec(fullText)?.[1]) ||
      (/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/i.exec(fullText)?.[1]);
    const date = normalizeDate(dateText);

    const statusTag =
      $el.find(".a-tag, .tag, .status, .u-right").first().text().trim() ||
      (/\b(Pending|Settled|Judgment|Dismissed|Final order|Default judgment)\b/i.exec(fullText)?.[1] ??
        "");
    const rawStatus = statusTag || undefined;
    const status = classifyStatus([rawStatus ?? "", respondent, fullText]);

    const summary = $el.find("p").first().text().replace(/\s+/g, " ").trim();
    const actionType = classifyActionType("CFPB", rawStatus, [respondent, summary, fullText]);
    const penalty = extractPenalty(`${respondent} ${summary} ${fullText}`);

    const actionId = `CFPB:${sanitizeId(detailUrl.replace("https://www.consumerfinance.gov", ""))}`;

    const provenance: Provenance = {
      source: "CFPB-html-listing",
      sourceUrl,
      fetchedAt: new Date().toISOString(),
      fieldOrigin: {
        agency: "observed",
        actionId: "observed",
        actionType: "normalized",
        rawActionType: rawStatus ? "observed" : "unknown",
        status: "normalized",
        rawStatus: rawStatus ? "observed" : "unknown",
        respondent: "observed",
        actionDate: date ? "observed" : "unknown",
        title: "observed",
        summary: summary ? "observed" : "unknown",
        documentUrl: "observed",
        penaltyAmount: penalty.origin,
      },
    };

    actions.push({
      actionId,
      agency: "CFPB",
      actionType,
      rawActionType: rawStatus,
      status,
      rawStatus,
      actionDate: date,
      respondent,
      respondents: [respondent],
      penaltyAmount: penalty.amount,
      penaltyCurrency: "USD",
      penaltyBreakdown: penalty.breakdown,
      title: respondent,
      summary: summary || undefined,
      allegations: summary || undefined,
      documentUrl: detailUrl,
      entityKey: normalizeEntityKey(respondent),
      provenance,
      rawPayload: { respondent, summary, fullText, detailUrl, dateText, rawStatus },
    });
  });

  return actions;
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 160);
}
