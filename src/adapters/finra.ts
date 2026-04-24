import * as cheerio from "cheerio";
import type { NormalizedAction, Provenance } from "../types.js";
import { classifyActionType } from "../normalization/actionTypes.js";
import { classifyStatus } from "../normalization/status.js";
import { normalizeDate } from "../normalization/dates.js";
import { extractPenalty } from "../normalization/penalties.js";
import { normalizeEntityKey } from "../normalization/entities.js";
import {
  combineText,
  fetchText,
  type AdapterRunResult,
  type AgencyAdapter,
} from "./base.js";

/**
 * FINRA adapter: parses the monthly disciplinary-action summary pages at
 *   https://www.finra.org/rules-guidance/oversight-enforcement/finra-disciplinary-actions
 *
 * Parsing strategy (defensive against FINRA's periodic site refreshes):
 *
 *   1. Fetch the landing page. FINRA links each monthly summary as
 *      /rules-guidance/oversight-enforcement/finra-disciplinary-actions-<month>-<year>
 *   2. Pull the first 3 most recent monthly pages.
 *   3. On each monthly page, enforcement entries are rendered in a set of
 *      named content sections. Each section contains "Firms Fined", "Firms
 *      Suspended", "Individuals Barred", etc. We iterate each <h2>/<h3>
 *      heading and group the subsequent <p> paragraphs until the next heading.
 *   4. Each paragraph typically starts with the respondent name in bold
 *      followed by the violation description and sanction.
 *
 * When FINRA redesigns the page (which has happened), parsing may yield zero
 * actions. The ingestion runner records that outcome as `partial` rather than
 * crashing, and `errors[]` carries a hint pointing at the current selectors.
 */

const FINRA_LANDING =
  "https://www.finra.org/rules-guidance/oversight-enforcement/finra-disciplinary-actions";

const MONTHLY_LINK_REGEX =
  /\/rules-guidance\/oversight-enforcement\/finra-disciplinary-actions-[a-z]+-\d{4}/i;

export class FINRAAdapter implements AgencyAdapter {
  readonly agency = "FINRA" as const;

  async fetchRecent(): Promise<AdapterRunResult> {
    const errors: AdapterRunResult["errors"] = [];
    const actions: NormalizedAction[] = [];

    let monthlyUrls: string[] = [];
    try {
      monthlyUrls = await this.discoverMonthlyPages();
    } catch (err) {
      errors.push({
        message: `FINRA landing-page fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        hint: `Verify ${FINRA_LANDING} still lists monthly pages. FINRA occasionally redesigns this navigation.`,
      });
      return { agency: "FINRA", sourceUrl: FINRA_LANDING, actions: [], errors };
    }

    if (monthlyUrls.length === 0) {
      errors.push({
        message: "FINRA landing page yielded no monthly-summary links",
        hint: `Adjust MONTHLY_LINK_REGEX in src/adapters/finra.ts; FINRA may have changed its URL structure. Inspected: ${FINRA_LANDING}`,
      });
      return { agency: "FINRA", sourceUrl: FINRA_LANDING, actions: [], errors };
    }

    const recent = monthlyUrls.slice(0, 3);
    for (const url of recent) {
      try {
        const html = await fetchText(url, 20_000);
        const parsed = this.parseMonthlyPage(html, url);
        actions.push(...parsed);
        if (parsed.length === 0) {
          errors.push({
            message: `FINRA monthly page parsed 0 actions`,
            hint: `Page structure may have changed. URL: ${url}. Selectors are documented in src/adapters/finra.ts.`,
          });
        }
      } catch (err) {
        errors.push({
          message: `FINRA monthly-page fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          hint: `URL: ${url}`,
        });
      }
    }

    return { agency: "FINRA", sourceUrl: FINRA_LANDING, actions, errors };
  }

  private async discoverMonthlyPages(): Promise<string[]> {
    const html = await fetchText(FINRA_LANDING, 15_000);
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const urls: string[] = [];
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || !MONTHLY_LINK_REGEX.test(href)) return;
      const absolute = href.startsWith("http") ? href : `https://www.finra.org${href}`;
      if (seen.has(absolute)) return;
      seen.add(absolute);
      urls.push(absolute);
    });
    return urls;
  }

  private parseMonthlyPage(html: string, sourceUrl: string): NormalizedAction[] {
    const $ = cheerio.load(html);
    const actions: NormalizedAction[] = [];

    // Collect content region: FINRA uses <main> or .main-content.
    const root = $("main").first().length ? $("main").first() : $("body");

    // Determine the publication month/year from the URL slug if present.
    const monthMatch =
      /finra-disciplinary-actions-([a-z]+)-(\d{4})/i.exec(sourceUrl) ??
      /finra-disciplinary-actions-(\d{4})-([a-z]+)/i.exec(sourceUrl);
    const slugMonth = monthMatch?.[1];
    const slugYear = monthMatch?.[2];
    const publicationDate = slugMonth && slugYear
      ? normalizeDate(`${slugMonth} 15, ${slugYear}`)
      : undefined;

    let currentSection = "Unknown";
    root.find("h2, h3, h4, p").each((_, el) => {
      const tag = el.tagName?.toLowerCase();
      if (tag === "h2" || tag === "h3" || tag === "h4") {
        const txt = $(el).text().trim();
        if (txt && txt.length < 120) currentSection = txt;
        return;
      }

      const paragraph = $(el).text().trim();
      if (paragraph.length < 40) return;

      // FINRA typically starts each entry with the respondent name in bold.
      const respondent = extractFinraRespondent($, el) ?? paragraph.split(/[,.]/)[0]?.trim() ?? "";
      if (!respondent || respondent.length < 3) return;

      const actionId = `FINRA:${sanitizeId(`${currentSection}|${respondent}|${publicationDate ?? ""}`)}`;
      const rawActionType = currentSection;
      const actionType = classifyActionType("FINRA", currentSection, [paragraph]);
      const status = classifyStatus([currentSection, paragraph]);
      const penalty = extractPenalty(paragraph);

      const provenance: Provenance = {
        source: "FINRA-disciplinary-actions-html",
        sourceUrl,
        fetchedAt: new Date().toISOString(),
        fieldOrigin: {
          agency: "observed",
          actionId: "inferred",
          actionType: "normalized",
          rawActionType: "observed",
          status: "normalized",
          respondent: "inferred",
          actionDate: "inferred",
          title: "observed",
          allegations: "observed",
          penaltyAmount: penalty.origin,
          documentUrl: "observed",
        },
      };

      actions.push({
        actionId,
        agency: "FINRA",
        actionType,
        rawActionType,
        status,
        actionDate: publicationDate,
        respondent: respondent.slice(0, 255),
        respondents: [respondent],
        penaltyAmount: penalty.amount,
        penaltyCurrency: "USD",
        penaltyBreakdown: penalty.breakdown,
        title: `${currentSection}: ${respondent}`.slice(0, 255),
        summary: paragraph.slice(0, 2000),
        allegations: paragraph,
        documentUrl: sourceUrl,
        entityKey: normalizeEntityKey(respondent),
        provenance,
        rawPayload: { section: currentSection, paragraph },
      });
    });

    return actions;
  }
}

function extractFinraRespondent($: cheerio.CheerioAPI, el: import("domhandler").Element): string | null {
  const strong = $(el).find("strong, b").first().text().trim();
  if (strong && strong.length >= 3 && strong.length <= 200) return strong;
  const fullText = $(el).text().trim();
  // "Firm Name (CRD #12345)" or "Last, First (CRD #...)"
  const nameMatch = /^([A-Z][^()\n]{2,120})\s*\(/.exec(fullText);
  if (nameMatch?.[1]) return nameMatch[1].trim();
  return null;
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 180);
}
