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
 * FinCEN adapter: parses the public enforcement-actions index at
 *   https://www.fincen.gov/news-room/enforcement-actions
 *
 * FinCEN publishes civil money penalties (assessments), consent orders,
 * and statements of facts. Each entry on the index page links to a detail
 * press release. We parse the index table / card list and normalize each row.
 */

const FINCEN_INDEX = "https://www.fincen.gov/news-room/enforcement-actions";

export class FinCENAdapter implements AgencyAdapter {
  readonly agency = "FINCEN" as const;

  async fetchRecent(): Promise<AdapterRunResult> {
    const errors: AdapterRunResult["errors"] = [];
    let html: string;
    try {
      html = await fetchText(FINCEN_INDEX, 20_000);
    } catch (err) {
      errors.push({
        message: `FinCEN fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        hint: `Verify ${FINCEN_INDEX} is still the canonical enforcement index.`,
      });
      return { agency: "FINCEN", sourceUrl: FINCEN_INDEX, actions: [], errors };
    }

    const actions: NormalizedAction[] = [];
    const $ = cheerio.load(html);
    const rows = collectRows($);

    for (const row of rows) {
      const actionId = `FINCEN:${sanitizeId(row.href)}`;
      const date = normalizeDate(row.date);
      const actionType = classifyActionType("FINCEN", row.title, [row.summary ?? ""]);
      const status = classifyStatus([row.title, row.summary ?? ""]);
      const respondent = extractFincenRespondent(row.title, row.summary);
      const penalty = extractPenalty([row.title, row.summary].filter(Boolean).join(" "));

      const provenance: Provenance = {
        source: "FINCEN-news-room-enforcement-actions",
        sourceUrl: FINCEN_INDEX,
        fetchedAt: new Date().toISOString(),
        fieldOrigin: {
          agency: "observed",
          actionId: "observed",
          actionType: "normalized",
          status: "normalized",
          respondent: "inferred",
          actionDate: row.date ? "observed" : "unknown",
          title: "observed",
          summary: row.summary ? "observed" : "unknown",
          penaltyAmount: penalty.origin,
          documentUrl: "observed",
        },
      };

      actions.push({
        actionId,
        agency: "FINCEN",
        actionType,
        status,
        actionDate: date,
        respondent: respondent.slice(0, 255),
        respondents: [respondent],
        penaltyAmount: penalty.amount,
        penaltyCurrency: "USD",
        penaltyBreakdown: penalty.breakdown,
        title: row.title.slice(0, 255),
        summary: row.summary,
        allegations: row.summary,
        documentUrl: row.href,
        entityKey: normalizeEntityKey(respondent),
        provenance,
        rawPayload: row,
      });
    }

    if (actions.length === 0) {
      errors.push({
        message: "FinCEN index page yielded no rows",
        hint: `FinCEN may have changed the enforcement-actions index layout. Inspect ${FINCEN_INDEX} and update selectors in src/adapters/fincen.ts.`,
      });
    }

    return { agency: "FINCEN", sourceUrl: FINCEN_INDEX, actions, errors };
  }
}

function collectRows(
  $: cheerio.CheerioAPI,
): Array<{ title: string; href: string; date: string | undefined; summary: string | undefined }> {
  const rows: Array<{ title: string; href: string; date: string | undefined; summary: string | undefined }> =
    [];

  // Strategy 1: table rows.
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 2) return;
    const link = cells.find("a").first();
    const title = link.text().trim() || cells.eq(0).text().trim();
    const href = absolutize(link.attr("href"));
    if (!title || !href) return;
    const dateText = cells.eq(cells.length - 1).text().trim();
    rows.push({
      title,
      href,
      date: dateText || undefined,
      summary: undefined,
    });
  });

  if (rows.length > 0) return rows;

  // Strategy 2: card/list layout.
  $("article, .views-row, li").each((_, el) => {
    const link = $(el).find("a[href*='news-room']").first();
    const href = absolutize(link.attr("href"));
    const title = link.text().trim();
    if (!href || !title) return;
    const dateText = $(el).find("time, .date, .field--name-field-date").first().text().trim();
    const summary = $(el).find("p, .field--name-body").first().text().trim();
    rows.push({ title, href, date: dateText || undefined, summary: summary || undefined });
  });

  return rows;
}

function absolutize(href: string | undefined): string {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  return `https://www.fincen.gov${href}`;
}

function extractFincenRespondent(title: string, summary: string | undefined): string {
  const patterns = [
    /Assessment\s+of\s+Civil\s+Money\s+Penalty\s+Against\s+(.+)/i,
    /FinCEN\s+Penalizes\s+(.+?)(?:\s+for|,|$)/i,
    /FinCEN\s+Announces?\s+[^A]*Against\s+(.+?)(?:\s+for|,|$)/i,
    /FinCEN\s+Files?\s+Enforcement\s+Action\s+Against\s+(.+?)(?:\s+for|,|$)/i,
    /^(.+?)\s+-\s+/,
  ];
  for (const p of patterns) {
    const m = p.exec(title);
    if (m?.[1]) return cleanName(m[1]);
  }
  if (summary) {
    const m = /against\s+([A-Z][A-Za-z0-9 &'\.,-]{2,80})/.exec(summary);
    if (m?.[1]) return cleanName(m[1]);
  }
  return cleanName(title);
}

function cleanName(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/[,.;:]+$/, "").trim().slice(0, 240);
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 180);
}
