import { XMLParser } from "fast-xml-parser";
import type {
  NormalizedAction,
  Provenance,
} from "../types.js";
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

const SEC_FEEDS = [
  {
    key: "litigation_releases",
    url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=&company=&dateb=&owner=include&count=40&output=atom",
    hintSource: "SEC-EDGAR-current",
  },
  {
    key: "press_releases",
    url: "https://www.sec.gov/news/pressreleases.rss",
    hintSource: "SEC-press-releases-rss",
  },
] as const;

/**
 * SEC adapter: ingests current litigation releases, administrative proceedings,
 * and enforcement-tagged press releases via EDGAR RSS/Atom feeds. SEC does not
 * require an API key but asks for a descriptive User-Agent header.
 *
 * Notes on source selection:
 *   - sec.gov/litigation/litreleases/litrel.rss historically serves SEC
 *     litigation releases. The generic pressreleases.rss feed covers both
 *     enforcement-tagged press releases and policy announcements. We filter
 *     the latter to enforcement content only.
 *   - The EDGAR current Atom feed includes many filing types; we keep only
 *     entries whose titles match enforcement-related signals.
 */
export class SECAdapter implements AgencyAdapter {
  readonly agency = "SEC" as const;

  async fetchRecent(): Promise<AdapterRunResult> {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      parseTagValue: false,
      trimValues: true,
    });

    const actions: NormalizedAction[] = [];
    const errors: AdapterRunResult["errors"] = [];

    const primaryFeed = "https://www.sec.gov/news/pressreleases.rss";
    try {
      const xml = await fetchText(primaryFeed, 15_000);
      const doc = parser.parse(xml);
      const items: Array<Record<string, unknown>> = asArray(doc?.rss?.channel?.item);
      for (const item of items) {
        const title = asString(item.title);
        const description = asString(item.description);
        const link = asString(item.link);
        const guid = asString(item.guid) ?? link ?? title ?? "";
        const pub = asString(item.pubDate);

        if (!isEnforcement(title, description)) continue;
        if (!title || !link) continue;

        const respondent = extractRespondent(title, description);
        const action = this.buildAction({
          sourceKey: "press_release",
          sourceUrl: primaryFeed,
          rawGuid: guid,
          title,
          summary: description,
          link,
          respondent,
          pubDate: pub,
        });
        if (action) actions.push(action);
      }
    } catch (err) {
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        hint: `SEC press-release RSS fetch failed at ${primaryFeed}. Consider checking https://www.sec.gov/news/pressreleases.rss manually; SEC occasionally rate-limits anonymous clients.`,
      });
    }

    return { agency: "SEC", sourceUrl: primaryFeed, actions, errors };
  }

  private buildAction(params: {
    sourceKey: string;
    sourceUrl: string;
    rawGuid: string;
    title: string;
    summary: string | undefined;
    link: string;
    respondent: string;
    pubDate: string | undefined;
  }): NormalizedAction | null {
    const id = extractReleaseId(params.title, params.link, params.rawGuid);
    if (!id) return null;
    const actionId = `SEC:${id}`;
    const date = normalizeDate(params.pubDate);
    const text = combineText(params.title, params.summary);
    const actionType = classifyActionType("SEC", undefined, [params.title, params.summary ?? ""]);
    const status = classifyStatus([params.title, params.summary ?? ""]);
    const penalty = extractPenalty(text);

    const provenance: Provenance = {
      source: `SEC-${params.sourceKey}`,
      sourceUrl: params.sourceUrl,
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

    return {
      actionId,
      agency: "SEC",
      actionType,
      rawActionType: params.sourceKey,
      status,
      actionDate: date,
      respondent: params.respondent,
      respondents: [params.respondent],
      penaltyAmount: penalty.amount,
      penaltyCurrency: "USD",
      penaltyBreakdown: penalty.breakdown,
      title: params.title,
      summary: params.summary,
      allegations: params.summary,
      documentUrl: params.link,
      entityKey: normalizeEntityKey(params.respondent),
      provenance,
      rawPayload: { title: params.title, summary: params.summary, link: params.link },
    };
  }
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value === undefined || value === null) return [];
  return [value as T];
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "#text" in v && typeof (v as Record<string, unknown>)["#text"] === "string") {
    return (v as Record<string, unknown>)["#text"] as string;
  }
  return undefined;
}

function isEnforcement(title: string | undefined, description: string | undefined): boolean {
  const t = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  if (!t) return false;
  return (
    t.includes("charge") ||
    t.includes("charges") ||
    t.includes("enforce") ||
    t.includes("action") ||
    t.includes("violat") ||
    t.includes("fraud") ||
    t.includes("penalt") ||
    t.includes("settle") ||
    t.includes("order") ||
    t.includes("cease")
  );
}

function extractReleaseId(title: string, link: string, guid: string): string | null {
  const linkMatch = /litreleases\/lr-?(\d+)/i.exec(link) || /litrel(\d+)/i.exec(link);
  if (linkMatch?.[1]) return `LR-${linkMatch[1]}`;
  const pressMatch = /press[-_]?release\/(\d+-\d+)/i.exec(link) || /(\d{4}-\d+)\.htm/.exec(link);
  if (pressMatch?.[1]) return `PR-${pressMatch[1]}`;
  if (guid && guid.length < 200) return `GUID-${hashString(guid)}`;
  if (title) return `TITLE-${hashString(title)}`;
  return null;
}

function extractRespondent(title: string, description: string | undefined): string {
  const vsMatch = /SEC\s+(?:charges|sues|files\s+charges\s+against|obtains\s+emergency\s+relief\s+against|settles\s+charges\s+with)\s+(.+?)\s+(?:for|with|over|in connection|alleg|and|,|\.|$)/i.exec(
    title,
  );
  if (vsMatch?.[1]) return cleanRespondent(vsMatch[1]);

  const dash = title.split(/ - | — |: /);
  if (dash.length > 1 && (dash[1] ?? "").length > 2) {
    return cleanRespondent(dash[0] ?? title);
  }

  if (description) {
    const m = /(?:against|with|charged)\s+([A-Z][A-Za-z0-9 &'\.,-]{2,60})/.exec(description);
    if (m?.[1]) return cleanRespondent(m[1]);
  }

  return cleanRespondent(title);
}

function cleanRespondent(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/[.;,:]+$/, "").trim().slice(0, 255);
}

function hashString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
