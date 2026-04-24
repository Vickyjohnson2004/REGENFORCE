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
import { XMLParser } from "fast-xml-parser";

/**
 * FTC adapter: Uses the official FTC public data API when DATA_GOV_API_KEY
 * is configured; falls back to the FTC press-releases RSS feed when it isn't.
 *
 * API docs: https://www.ftc.gov/developer/api
 * Cases & proceedings: https://www.ftc.gov/legal-library/browse/cases-proceedings
 *
 * The FTC's JSON endpoint paths have been renamed in the past. We try a few
 * known patterns and gracefully degrade when all fail.
 */

const RSS_FEED = "https://www.ftc.gov/feeds/press-release.xml";
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

  async fetchRecent(): Promise<AdapterRunResult> {
    const errors: AdapterRunResult["errors"] = [];

    if (config.dataGovApiKey) {
      const apiResult = await this.tryDataGov(errors);
      if (apiResult.actions.length > 0) return apiResult;
    } else {
      errors.push({
        message: "DATA_GOV_API_KEY not set; falling back to FTC press-release RSS feed",
        hint: "Request a free key at https://api.data.gov/signup/",
      });
    }

    return this.rssFallback(errors);
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
          hint: `Endpoint ${url} failed. Data.gov endpoint paths shift occasionally; see https://github.com/FederalTradeCommission/ftc-api-docs for current list.`,
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

  private async rssFallback(errors: AdapterRunResult["errors"]): Promise<AdapterRunResult> {
    try {
      const xml = await fetchText(RSS_FEED, 15_000);
      const parser = new XMLParser({
        ignoreAttributes: false,
        trimValues: true,
        parseTagValue: false,
      });
      const doc = parser.parse(xml);
      const items: Array<Record<string, unknown>> = toArr(doc?.rss?.channel?.item);
      const actions: NormalizedAction[] = [];
      for (const item of items) {
        const title = asStr(item.title);
        const description = asStr(item.description);
        const link = asStr(item.link);
        const pub = asStr(item.pubDate);
        const guid = asStr(item.guid);
        if (!title || !link) continue;
        if (!isFtcEnforcement(title, description)) continue;

        const respondent = extractFtcRespondent(title, description);
        const actionType = classifyActionType("FTC", undefined, [title, description ?? ""]);
        const status = classifyStatus([title, description ?? ""]);
        const penalty = extractPenalty(combineText(title, description));
        const actionId = `FTC:${sanitizeId(guid ?? link ?? title)}`;

        const provenance: Provenance = {
          source: "FTC-press-release-rss",
          sourceUrl: RSS_FEED,
          fetchedAt: new Date().toISOString(),
          fieldOrigin: {
            agency: "observed",
            actionId: "observed",
            actionType: "normalized",
            status: "normalized",
            respondent: "normalized",
            actionDate: "normalized",
            title: "observed",
            summary: "observed",
            documentUrl: "observed",
            penaltyAmount: penalty.origin,
          },
        };

        actions.push({
          actionId,
          agency: "FTC",
          actionType,
          status,
          actionDate: normalizeDate(pub),
          respondent,
          respondents: [respondent],
          penaltyAmount: penalty.amount,
          penaltyCurrency: "USD",
          penaltyBreakdown: penalty.breakdown,
          allegations: description,
          title,
          summary: description,
          documentUrl: link,
          entityKey: normalizeEntityKey(respondent),
          provenance,
          rawPayload: { title, description, link, pubDate: pub },
        });
      }
      return { agency: "FTC", sourceUrl: RSS_FEED, actions, errors };
    } catch (err) {
      errors.push({
        message: `FTC RSS fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        hint: `Verify ${RSS_FEED} is still the canonical feed.`,
      });
      return { agency: "FTC", sourceUrl: RSS_FEED, actions: [], errors };
    }
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

function asStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "#text" in v && typeof (v as Record<string, unknown>)["#text"] === "string") {
    return (v as Record<string, unknown>)["#text"] as string;
  }
  return undefined;
}

function toArr<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v === undefined || v === null) return [];
  return [v as T];
}

function isFtcEnforcement(title: string, description: string | undefined): boolean {
  const text = `${title} ${description ?? ""}`.toLowerCase();
  return (
    text.includes("settlement") ||
    text.includes("complaint") ||
    text.includes("enforcement") ||
    text.includes("action") ||
    text.includes("order") ||
    text.includes("penalty") ||
    text.includes("violation") ||
    text.includes("charge")
  );
}

function extractFtcRespondent(title: string, description: string | undefined): string {
  const m = /(?:FTC|Federal Trade Commission)[^:]*(?:sues|orders|charges|takes action against|files\s+complaint\s+against|settles\s+with|reaches\s+settlement\s+with)\s+([^,;:.]+)/i.exec(
    title,
  );
  if (m?.[1]) return m[1].replace(/\s+/g, " ").trim();
  if (description) {
    const m2 = /against\s+([A-Z][A-Za-z0-9 &'\.,-]{2,80})/.exec(description);
    if (m2?.[1]) return m2[1].trim();
  }
  return title.split(/ - | — |: /)[0]?.slice(0, 200).trim() ?? title.slice(0, 200);
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}
