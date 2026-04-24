import * as cheerio from "cheerio";
import type {
  NormalizedAction,
  Provenance,
} from "../types.js";
import { config } from "../config.js";
import { classifyActionType } from "../normalization/actionTypes.js";
import { classifyStatus } from "../normalization/status.js";
import { normalizeDate } from "../normalization/dates.js";
import {
  extractPenalty,
  parsePenaltyAmount,
} from "../normalization/penalties.js";
import { normalizeEntityKey } from "../normalization/entities.js";
import {
  combineText,
  fetchJson,
  fetchText,
  type AdapterRunResult,
  type AgencyAdapter,
} from "./base.js";

/**
 * FTC adapter.
 *
 * Preference order:
 *   1. Official FTC data.gov API (requires a free DATA_GOV_API_KEY). Endpoints
 *      for nonmerger / merger / civil-penalty actions live at
 *      https://api.data.gov/ftc/v0/*
 *      Documented at https://github.com/FederalTradeCommission/ftc-api-docs
 *   2. HTML scrape of https://www.ftc.gov/news-events/news/press-releases
 *      which lists ~50 recent press releases in a structured views-row grid.
 *      FTC's legacy RSS feed (press-release.xml) now 403s on most crawlers.
 */

const FTC_PRESS_PAGE_BASE =
  "https://www.ftc.gov/news-events/news/press-releases?items_per_page=50";
const FTC_PRESS_PAGES = [
  FTC_PRESS_PAGE_BASE,
  `${FTC_PRESS_PAGE_BASE}&page=1`,
  `${FTC_PRESS_PAGE_BASE}&page=2`,
];
const DATA_GOV_BASE = "https://api.data.gov/ftc/v0";

interface FtcCase {
  case_id?: string | number;
  title?: string;
  respondents?: string;
  matter_type?: string;
  case_type?: string;
  filed_date?: string;
  date?: string;
  action?: string;
  status?: string;
  civil_penalty_amount?: string | number;
  summary?: string;
  url?: string;
  document_url?: string;
}

interface DataGovResponse<T> {
  data?: T[];
  results?: T[];
  status?: string;
  message?: string;
}

export class FTCAdapter implements AgencyAdapter {
  readonly agency = "FTC" as const;
  readonly runTimeoutMs = 60_000;

  async fetchRecent(): Promise<AdapterRunResult> {
    const errors: AdapterRunResult["errors"] = [];

    if (config.dataGovApiKey) {
      const apiResult = await this.tryDataGov(errors);
      if (apiResult.actions.length > 0) return apiResult;
    }

    // HTML scrape of the public press-releases listing.
    return this.scrapePressPages(errors);
  }

  private async tryDataGov(errors: AdapterRunResult["errors"]): Promise<AdapterRunResult> {
    const endpoints = [
      "/nonmerger-enforcement-actions?limit=100",
      "/civil-penalty-actions?limit=100",
      "/merger-enforcement-actions?limit=100",
    ];
    const actions: NormalizedAction[] = [];
    let successfulEndpoint = "";

    for (const endpoint of endpoints) {
      const url = `${DATA_GOV_BASE}${endpoint}`;
      try {
        const res = await fetchJson<DataGovResponse<FtcCase>>(url, {
          headers: { "X-Api-Key": config.dataGovApiKey },
          timeoutMs: 15_000,
        });
        const rows = res.data ?? res.results ?? [];
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          const action = this.normalizeCase(row, `FTC-data.gov${endpoint}`, url);
          if (action) actions.push(action);
        }
        if (rows.length > 0 && !successfulEndpoint) successfulEndpoint = url;
      } catch (err) {
        errors.push({
          message: `FTC API ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
          hint: `Endpoint ${url} failed. data.gov endpoint paths shift occasionally; see https://github.com/FederalTradeCommission/ftc-api-docs for the current list.`,
        });
      }
    }

    return {
      agency: "FTC",
      sourceUrl: successfulEndpoint || DATA_GOV_BASE,
      actions,
      errors,
    };
  }

  private async scrapePressPages(errors: AdapterRunResult["errors"]): Promise<AdapterRunResult> {
    const actions: NormalizedAction[] = [];
    const seen = new Set<string>();

    for (const page of FTC_PRESS_PAGES) {
      try {
        const html = await fetchText(page, 20_000);
        const parsed = parseFtcListing(html, page);
        for (const a of parsed) {
          if (!seen.has(a.actionId)) {
            seen.add(a.actionId);
            actions.push(a);
          }
        }
      } catch (err) {
        errors.push({
          message: `FTC press-release page fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          hint: `URL: ${page}. Verify in browser.`,
        });
      }
    }

    if (actions.length === 0 && errors.length === 0) {
      errors.push({
        message: "FTC press-release listing yielded no enforcement rows",
        hint: `Selectors or enforcement-signal filter may need updating in src/adapters/ftc.ts.`,
      });
    }

    return {
      agency: "FTC",
      sourceUrl: FTC_PRESS_PAGE_BASE,
      actions,
      errors,
    };
  }

  private normalizeCase(row: FtcCase, source: string, sourceUrl: string): NormalizedAction | null {
    const respondent = row.respondents ?? row.title;
    if (!respondent) return null;
    const id = row.case_id ?? `${row.title}|${row.filed_date ?? row.date ?? ""}`;
    const actionId = `FTC:${sanitizeId(String(id))}`;
    const rawActionType = row.action ?? row.matter_type ?? row.case_type;
    const actionType = classifyActionType("FTC", rawActionType, [
      row.title ?? "",
      row.summary ?? "",
    ]);
    const status = classifyStatus([row.status ?? "", row.action ?? ""]);
    const date = normalizeDate(row.filed_date ?? row.date);

    let amount = parsePenaltyAmount(row.civil_penalty_amount);
    let origin: "observed" | "inferred" | "unknown" = amount ? "observed" : "unknown";
    let breakdown: NormalizedAction["penaltyBreakdown"];
    if (!amount && row.summary) {
      const ext = extractPenalty(row.summary);
      amount = ext.amount;
      origin = ext.origin;
      breakdown = ext.breakdown;
    } else if (amount) {
      breakdown = [{ amount, currency: "USD", type: "civil_penalty" }];
    }

    const provenance: Provenance = {
      source,
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
        penaltyAmount: origin,
        penaltyBreakdown: breakdown ? origin : "unknown",
        allegations: row.summary ? "observed" : "unknown",
        documentUrl: (row.url ?? row.document_url) ? "observed" : "unknown",
      },
    };

    return {
      actionId,
      agency: "FTC",
      actionType,
      rawActionType,
      status,
      rawStatus: row.status,
      actionDate: date,
      respondent: String(respondent),
      respondents: [String(respondent)],
      penaltyAmount: amount,
      penaltyCurrency: "USD",
      penaltyBreakdown: breakdown,
      allegations: row.summary,
      title: row.title ?? String(respondent),
      summary: row.summary,
      documentUrl: row.url ?? row.document_url,
      entityKey: normalizeEntityKey(String(respondent)),
      provenance,
      rawPayload: row,
    };
  }
}

/**
 * Parse the FTC press-releases listing. Each row is a `<div class="views-row">`
 * containing a `<h3><a href="...">title</a></h3>`, date, and summary paragraph.
 */
function parseFtcListing(html: string, sourceUrl: string): NormalizedAction[] {
  const $ = cheerio.load(html);
  const actions: NormalizedAction[] = [];

  $(".views-row").each((_, el) => {
    const $el = $(el);
    const anchor = $el
      .find("a")
      .filter((_, a) => {
        const href = $(a).attr("href") ?? "";
        return /\/news-events\/news\/press-releases\/\d{4}\//.test(href);
      })
      .first();
    const href = anchor.attr("href") ?? "";
    const title = anchor.text().replace(/\s+/g, " ").trim();
    if (!title || !href) return;
    if (!isFtcEnforcement(title, "")) return;

    const url = href.startsWith("http") ? href : `https://www.ftc.gov${href}`;
    const dateText =
      $el.find("time").attr("datetime") ||
      $el.find("time").first().text().trim() ||
      inferDateFromUrl(href);
    const date = normalizeDate(dateText);

    const summary = $el.find("p").first().text().replace(/\s+/g, " ").trim();
    const body = combineText(title, summary);
    const actionType = classifyActionType("FTC", undefined, [title, summary]);
    const status = classifyStatus([title, summary]);
    const penalty = extractPenalty(body);
    const respondent = extractFtcRespondent(title, summary);

    const actionId = `FTC:${sanitizeId(href)}`;
    const provenance: Provenance = {
      source: "FTC-press-release-listing",
      sourceUrl,
      fetchedAt: new Date().toISOString(),
      fieldOrigin: {
        agency: "observed",
        actionId: "observed",
        actionType: "normalized",
        status: "normalized",
        respondent: "inferred",
        actionDate: date ? "observed" : "unknown",
        title: "observed",
        summary: summary ? "observed" : "unknown",
        documentUrl: "observed",
        penaltyAmount: penalty.origin,
      },
    };

    actions.push({
      actionId,
      agency: "FTC",
      actionType,
      status,
      actionDate: date,
      respondent,
      respondents: [respondent],
      penaltyAmount: penalty.amount,
      penaltyCurrency: "USD",
      penaltyBreakdown: penalty.breakdown,
      title,
      summary: summary || undefined,
      allegations: summary || undefined,
      documentUrl: url,
      entityKey: normalizeEntityKey(respondent),
      provenance,
      rawPayload: { title, summary, href },
    });
  });

  return actions;
}

function isFtcEnforcement(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase();
  return (
    text.includes("ftc sues") ||
    text.includes("ftc takes action") ||
    text.includes("ftc charges") ||
    text.includes("ftc files") ||
    text.includes("court orders") ||
    text.includes("settlement") ||
    text.includes("complaint") ||
    text.includes("enforcement") ||
    text.includes("penalty") ||
    text.includes("violation") ||
    text.includes("refund") ||
    text.includes("ftc stops") ||
    text.includes("ftc order") ||
    text.includes("consent order") ||
    text.includes("deceptive") ||
    /ftc\s+and\s+[A-Z]/.test(text)
  );
}

function extractFtcRespondent(title: string, description: string | undefined): string {
  const patterns = [
    /(?:FTC|Federal Trade Commission)[^:]*(?:sues|orders|charges|takes action against|files\s+complaint\s+against|settles\s+with|reaches\s+settlement\s+with|stops)\s+([^,;:.]+?)(?:\s+for|\s+over|,|$)/i,
    /Court\s+Orders?\s+([A-Z][^,;:]+?)\s+(?:to\s+Pay|to\s+Cease)/i,
    /^([A-Z][A-Za-z0-9 &'.,-]{2,80})\s+(?:to\s+Pay|Refunding|Refunds|Fined|Penalized)/,
  ];
  for (const p of patterns) {
    const m = p.exec(title);
    if (m?.[1]) return m[1].replace(/\s+/g, " ").trim().slice(0, 240);
  }
  if (description) {
    const m2 = /against\s+([A-Z][A-Za-z0-9 &'.,-]{2,80})/.exec(description);
    if (m2?.[1]) return m2[1].trim();
  }
  return title.split(/ - | — |: /)[0]?.slice(0, 200).trim() ?? title.slice(0, 200);
}

function inferDateFromUrl(href: string): string | undefined {
  const m = /\/press-releases\/(\d{4})\/(\d{2})\//.exec(href);
  if (m?.[1] && m?.[2]) return `${m[1]}-${m[2]}-01`;
  return undefined;
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 160);
}
