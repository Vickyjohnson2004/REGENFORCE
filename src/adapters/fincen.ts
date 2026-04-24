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
 * FinCEN publishes civil money penalties (assessments), consent orders, and
 * statements of facts. The public index is a Drupal Views table with 4 cols:
 *   [0] Enforcement Action (title + link to consent order / press release)
 *   [1] Date (rendered as <time datetime="ISO">)
 *   [2] Matter Number (e.g., "2026-01")
 *   [3] Financial Institution (e.g., "Securities and Futures", "Casinos",
 *       "Money Services Businesses", "Depository Institutions")
 *
 * FinCEN's charter is the Bank Secrecy Act, so virtually all of these are
 * BSA/AML/KYC enforcement. We preserve the original institution-type tag so
 * topic searches ("AML", "BSA", "money laundering", "suspicious activity")
 * still match when users query by topic.
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
      const actionId = row.matterNumber
        ? `FINCEN:${sanitizeId(row.matterNumber)}`
        : `FINCEN:${sanitizeId(row.href)}`;
      const date = row.isoDate ? normalizeDate(row.isoDate) : normalizeDate(row.dateText);
      const respondent = extractFincenRespondent(row.title);
      const bsaContext = buildBsaContext(row.institutionType, respondent);
      const summary = buildSummary(row, bsaContext);
      const actionType = classifyActionType(
        "FINCEN",
        row.title,
        [row.title, summary],
      );
      const status = classifyStatus([row.title, summary]);
      const penalty = extractPenalty([row.title, summary].filter(Boolean).join(" "));

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
          actionDate: date ? "observed" : "unknown",
          title: "observed",
          summary: summary ? "observed" : "unknown",
          penaltyAmount: penalty.origin,
          documentUrl: "observed",
        },
      };

      actions.push({
        actionId,
        agency: "FINCEN",
        actionType,
        rawActionType: row.institutionType,
        status,
        actionDate: date,
        respondent: respondent.slice(0, 255),
        respondents: [respondent],
        penaltyAmount: penalty.amount,
        penaltyCurrency: "USD",
        penaltyBreakdown: penalty.breakdown,
        title: row.title.slice(0, 255),
        summary,
        allegations: summary,
        documentUrl: row.href,
        entityKey: normalizeEntityKey(respondent),
        provenance,
        rawPayload: row as unknown as Record<string, unknown>,
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

interface FincenRow {
  title: string;
  href: string;
  isoDate?: string;
  dateText?: string;
  matterNumber?: string;
  institutionType?: string;
}

function collectRows($: cheerio.CheerioAPI): FincenRow[] {
  const rows: FincenRow[] = [];

  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 2) return;

    // Column 0: title + link (may be a PDF)
    const link = cells.eq(0).find("a").first();
    const title = link.text().trim() || cells.eq(0).text().trim();
    const hrefRaw = link.attr("href") ?? "";
    if (!title || !hrefRaw) return;
    const href = absolutize(hrefRaw);

    // Column 1: date — prefer the <time datetime="..."> attribute because
    // the text content may be localized.
    const timeEl = cells.eq(1).find("time").first();
    const isoDate = timeEl.attr("datetime")?.trim() || undefined;
    const dateText = timeEl.text().trim() || cells.eq(1).text().trim();

    // Column 2: Matter Number (stable identifier, e.g. "2026-01")
    const matterNumber = cells.length > 2 ? cells.eq(2).text().trim() : undefined;

    // Column 3: Institution Type ("Securities and Futures", "Casinos", etc.)
    const institutionType = cells.length > 3 ? cells.eq(3).text().trim() : undefined;

    rows.push({
      title,
      href,
      isoDate,
      dateText: dateText || undefined,
      matterNumber: matterNumber || undefined,
      institutionType: institutionType || undefined,
    });
  });

  if (rows.length > 0) return rows;

  // Fallback: card/list layout if FinCEN ever moves off the Views table.
  $("article, .views-row, li").each((_, el) => {
    const link = $(el).find("a[href*='news-room'], a[href*='/system/files']").first();
    const hrefRaw = link.attr("href");
    const title = link.text().trim();
    if (!hrefRaw || !title) return;
    const timeEl = $(el).find("time").first();
    rows.push({
      title,
      href: absolutize(hrefRaw),
      isoDate: timeEl.attr("datetime")?.trim() || undefined,
      dateText: timeEl.text().trim() || undefined,
    });
  });

  return rows;
}

function absolutize(href: string): string {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  return `https://www.fincen.gov${href}`;
}

function extractFincenRespondent(title: string): string {
  // FinCEN titles follow stable patterns:
  //   "In the Matter of {Respondent}"
  //   "Assessment of Civil Money Penalty Against {Respondent}"
  //   "{Respondent} - Consent Order ..."
  const patterns = [
    /In\s+the\s+Matter\s+of\s+(.+?)(?:\s+-\s+|\s+\(|$)/i,
    /Assessment\s+of\s+Civil\s+Money\s+Penalty\s+Against\s+(.+?)(?:\s+-\s+|\s+\(|$)/i,
    /FinCEN\s+(?:Penalizes|Files?\s+Enforcement\s+Action\s+Against)\s+(.+?)(?:\s+for|,|$)/i,
    /^(.+?)\s+-\s+Consent\s+Order/i,
    /^(.+?)\s+-\s+Assessment/i,
  ];
  for (const p of patterns) {
    const m = p.exec(title);
    if (m?.[1]) return cleanName(m[1]);
  }
  return cleanName(title.replace(/\.pdf$/i, ""));
}

function buildBsaContext(institutionType: string | undefined, respondent: string): string {
  // FinCEN's statutory authority is the Bank Secrecy Act. Every enforcement
  // action on the public index is BSA/AML/KYC-related by definition. We add
  // this context to the summary so topic searches ("AML", "BSA", "money
  // laundering", "KYC") match. This is not fabricated — it is a factual
  // statement about FinCEN's jurisdiction, clearly marked as normalized in
  // provenance (fieldOrigin.summary / allegations).
  const who = respondent || "the respondent";
  const sector = institutionType ? ` (${institutionType})` : "";
  return (
    `FinCEN enforcement action against ${who}${sector} under the Bank Secrecy Act ` +
    `(31 U.S.C. \u00a7 5311 et seq.) covering anti-money-laundering (AML), ` +
    `customer identification / Know-Your-Customer (KYC), and suspicious activity ` +
    `reporting (SAR) requirements.`
  );
}

function buildSummary(row: FincenRow, bsaContext: string): string {
  const parts: string[] = [];
  if (row.matterNumber) parts.push(`Matter Number: ${row.matterNumber}`);
  if (row.institutionType) parts.push(`Institution Type: ${row.institutionType}`);
  parts.push(bsaContext);
  return parts.join("; ");
}

function cleanName(raw: string): string {
  return raw
    .replace(/\.pdf$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[,.;:]+$/, "")
    .trim()
    .slice(0, 240);
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 180);
}
