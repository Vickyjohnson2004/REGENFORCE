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
 * OCC adapter: parses the OCC monthly enforcement-actions index at
 *   https://www.occ.gov/news-issuances/news-releases/
 * and
 *   https://www.occ.gov/topics/laws-and-regulations/occ-enforcement-actions/
 *
 * The OCC publishes civil money penalties, cease-and-desist orders, formal
 * agreements, and PCA directives against national banks and federal savings
 * associations. The index we target is the monthly press-release list that
 * links to each action. Structure is stable HTML (no API).
 */

const OCC_PRESS_INDEX = "https://www.occ.gov/news-issuances/news-releases/";

export class OCCAdapter implements AgencyAdapter {
  readonly agency = "OCC" as const;

  async fetchRecent(): Promise<AdapterRunResult> {
    const errors: AdapterRunResult["errors"] = [];
    let html: string;
    try {
      html = await fetchText(OCC_PRESS_INDEX, 20_000);
    } catch (err) {
      errors.push({
        message: `OCC press-index fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        hint: `Verify ${OCC_PRESS_INDEX} is still the canonical press-release index.`,
      });
      return { agency: "OCC", sourceUrl: OCC_PRESS_INDEX, actions: [], errors };
    }

    const $ = cheerio.load(html);
    const candidates: Array<{ title: string; href: string; date: string | undefined }> = [];

    // OCC uses article-style listings in recent designs. We also support a
    // simpler <li><a>title</a> — date</li> layout as a fallback.
    $("a").each((_, el) => {
      const title = $(el).text().trim();
      const href = $(el).attr("href");
      if (!title || !href) return;
      if (!/news-releases\/\d{4}/.test(href)) return;
      if (!isOccEnforcement(title)) return;
      const full = href.startsWith("http") ? href : `https://www.occ.gov${href}`;
      const dateText = $(el).closest("li, article, tr").find("time, .date").first().text().trim();
      candidates.push({ title, href: full, date: dateText || undefined });
    });

    if (candidates.length === 0) {
      errors.push({
        message: "OCC press index yielded no enforcement-related rows",
        hint: `OCC may have changed the enforcement listing layout. Inspect ${OCC_PRESS_INDEX} and update selectors in src/adapters/occ.ts.`,
      });
    }

    const actions: NormalizedAction[] = [];
    for (const row of candidates) {
      const actionId = `OCC:${sanitizeId(row.href)}`;
      const date = normalizeDate(row.date) ?? inferDateFromUrl(row.href);
      const actionType = classifyActionType("OCC", row.title, [row.title]);
      const status = classifyStatus([row.title]);
      const respondent = extractOccRespondent(row.title);
      const penalty = extractPenalty(row.title);

      const provenance: Provenance = {
        source: "OCC-news-releases-index",
        sourceUrl: OCC_PRESS_INDEX,
        fetchedAt: new Date().toISOString(),
        fieldOrigin: {
          agency: "observed",
          actionId: "observed",
          actionType: "normalized",
          status: "normalized",
          respondent: "inferred",
          actionDate: date ? "observed" : "unknown",
          title: "observed",
          penaltyAmount: penalty.origin,
          documentUrl: "observed",
        },
      };

      actions.push({
        actionId,
        agency: "OCC",
        actionType,
        status,
        actionDate: date,
        respondent,
        respondents: [respondent],
        penaltyAmount: penalty.amount,
        penaltyCurrency: "USD",
        penaltyBreakdown: penalty.breakdown,
        title: row.title.slice(0, 255),
        summary: row.title,
        allegations: row.title,
        documentUrl: row.href,
        entityKey: normalizeEntityKey(respondent),
        provenance,
        rawPayload: row,
      });
    }

    return { agency: "OCC", sourceUrl: OCC_PRESS_INDEX, actions, errors };
  }
}

function isOccEnforcement(title: string): boolean {
  const t = title.toLowerCase();
  return (
    t.includes("cease") ||
    t.includes("civil money penalty") ||
    t.includes("formal agreement") ||
    t.includes("consent order") ||
    t.includes("enforcement") ||
    t.includes("assess") ||
    t.includes("penalty against") ||
    t.includes("prompt corrective action")
  );
}

function extractOccRespondent(title: string): string {
  const patterns = [
    /(?:against|penalty\s+against|order\s+against|fines?)\s+([A-Z][^,;:.]{2,120})/i,
    /OCC\s+(?:orders|issues|assesses|announces)\s+[^A]*(?:against|with)\s+([A-Z][^,;:.]{2,120})/i,
    /^(.+?)\s+(?:Ordered|Fined|Penalized)/i,
  ];
  for (const p of patterns) {
    const m = p.exec(title);
    if (m?.[1]) return m[1].replace(/\s+/g, " ").trim().slice(0, 240);
  }
  return title.slice(0, 240);
}

function inferDateFromUrl(href: string): string | undefined {
  const m = /news-releases\/(\d{4})\/nr-(?:occ|ia)-(\d{4})-(\d+)/i.exec(href);
  if (m?.[1]) {
    return `${m[1]}-01-01`;
  }
  const y = /news-releases\/(\d{4})/.exec(href);
  return y?.[1] ? `${y[1]}-01-01` : undefined;
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 180);
}
