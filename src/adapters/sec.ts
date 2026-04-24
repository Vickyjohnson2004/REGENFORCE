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

/**
 * SEC adapter: pulls from two RSS/Atom feeds and merges them:
 *
 *   1. Litigation releases feed (LR-*): purely enforcement-focused civil
 *      lawsuit filings. Lives at
 *        https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8&dateb=&owner=include&count=40&output=atom
 *      and the legacy RSS at
 *        https://www.sec.gov/rss/litigation/litreleases.xml
 *
 *   2. Press releases feed. Mixes enforcement-tagged releases with rulemaking,
 *      staff appointments, and policy announcements. We filter to enforcement
 *      content using a strict signal set (charges/enforcement/penalty, etc.)
 *      and exclude commissioner-appointment / rulemaking noise.
 *
 * SEC's press.sec.gov and sec.gov endpoints accept anonymous requests and do
 * not require an API key; they do ask callers to identify themselves in
 * User-Agent (handled in base.ts).
 */
export class SECAdapter implements AgencyAdapter {
  readonly agency = "SEC" as const;
  readonly runTimeoutMs = 30_000;

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
    const seen = new Set<string>();

    // ------------------------------------------------------------------
    // Feed 1: Litigation Releases (enforcement-only).
    // SEC relocated these to /enforcement-litigation/* in 2025.
    // ------------------------------------------------------------------
    const litFeeds = [
      "https://www.sec.gov/enforcement-litigation/litigation-releases/rss",
      "https://www.sec.gov/enforcement-litigation/administrative-proceedings/rss",
    ];
    for (const feedUrl of litFeeds) {
      try {
        const xml = await fetchText(feedUrl, 15_000);
        const doc = parser.parse(xml);
        const items: Array<Record<string, unknown>> = asArray(
          doc?.rss?.channel?.item ?? doc?.feed?.entry,
        );
        for (const item of items) {
          const title = asString(item.title) ?? "";
          const summary =
            asString(item.description) ??
            asString(item.summary) ??
            asString(item.content) ??
            "";
          const link =
            asString(item.link) ??
            asString((item as { link?: { "@_href"?: string } }).link?.["@_href"]);
          const guid =
            asString(item.guid) ??
            asString(item.id) ??
            link ??
            title;
          const pub =
            asString(item.pubDate) ??
            asString(item.published) ??
            asString(item.updated);
          if (!title || !link) continue;

          const respondent = extractRespondent(title, summary);
          const action = this.buildAction({
            sourceKey: feedUrl.includes("admin") ? "administrative_proceeding" : "litigation_release",
            sourceUrl: feedUrl,
            rawGuid: guid ?? title,
            title,
            summary,
            link,
            respondent,
            pubDate: pub,
          });
          if (action && !seen.has(action.actionId)) {
            seen.add(action.actionId);
            actions.push(action);
          }
        }
      } catch (err) {
        errors.push({
          message: `SEC ${feedUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
          hint:
            "SEC occasionally rate-limits anonymous clients. Verify the feed in a browser and retry.",
        });
      }
    }

    // ------------------------------------------------------------------
    // Feed 2: Press releases, strictly filtered to enforcement content.
    // ------------------------------------------------------------------
    // SEC press-release RSS moved with the site redesign. Try both the new
    // location and the legacy one — whichever responds is used.
    const pressCandidates = [
      "https://www.sec.gov/news/pressreleases.rss",
      "https://www.sec.gov/newsroom/press-releases/rss",
    ];
    let pressUrl = pressCandidates[0]!;
    let pressXml: string | null = null;
    for (const candidate of pressCandidates) {
      try {
        pressXml = await fetchText(candidate, 15_000);
        pressUrl = candidate;
        break;
      } catch {
        // try next candidate
      }
    }
    if (!pressXml) {
      errors.push({
        message: `SEC press-release RSS fetch failed for all candidates`,
        hint: `Tried: ${pressCandidates.join(", ")}. SEC may have relocated the feed again.`,
      });
    } else {
      try {
        const doc = parser.parse(pressXml);
        const items: Array<Record<string, unknown>> = asArray(doc?.rss?.channel?.item);
        for (const item of items) {
          const title = asString(item.title) ?? "";
          const description = asString(item.description) ?? "";
          const link = asString(item.link);
          const guid = asString(item.guid) ?? link ?? title;
          const pub = asString(item.pubDate);

          if (!title || !link) continue;
          if (!isEnforcement(title, description)) continue;
          if (isExcluded(title, description)) continue;

          const respondent = extractRespondent(title, description);
          const action = this.buildAction({
            sourceKey: "press_release",
            sourceUrl: pressUrl,
            rawGuid: guid ?? title,
            title,
            summary: description,
            link,
            respondent,
            pubDate: pub,
          });
          if (action && !seen.has(action.actionId)) {
            seen.add(action.actionId);
            actions.push(action);
          }
        }
      } catch (err) {
        errors.push({
          message: `SEC press-release parse failed: ${err instanceof Error ? err.message : String(err)}`,
          hint: `URL: ${pressUrl}.`,
        });
      }
    }

    return { agency: "SEC", sourceUrl: pressUrl, actions, errors };
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
    const actionType = classifyActionType(
      "SEC",
      params.sourceKey,
      [params.title, params.summary ?? ""],
    );
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

/**
 * Strict enforcement signal set. Must contain at least one signal AND not
 * match the exclusion set below. Tuned to drop policy/appointment noise.
 */
function isEnforcement(title: string, description: string): boolean {
  const t = `${title} ${description}`.toLowerCase();
  if (!t) return false;
  return (
    t.includes("sec charges") ||
    t.includes("sec files charges") ||
    t.includes("sec sues") ||
    t.includes("sec obtains") ||
    t.includes("sec settles") ||
    t.includes("sec orders") ||
    t.includes("sec announces charges") ||
    t.includes("cease-and-desist") ||
    t.includes("cease and desist") ||
    t.includes("civil penalty") ||
    t.includes("enforcement action") ||
    t.includes("fraud charges") ||
    t.includes("securities fraud") ||
    t.includes("insider trading") ||
    t.includes("ponzi") ||
    t.includes("disgorg") ||
    /charged\s+(with|in)\s/.test(t)
  );
}

/**
 * Exclude commissioner appointments, rulemaking, exemptive orders, and other
 * non-enforcement SEC content that still mentions "order" or "action".
 */
function isExcluded(title: string, description: string): boolean {
  const t = `${title} ${description}`.toLowerCase();
  return (
    t.includes("appoints") ||
    t.includes("nominat") ||
    t.includes("resign") ||
    t.includes("exemptive order") ||
    t.includes("no-action letter") ||
    t.includes("proposed rule") ||
    t.includes("request for comment") ||
    t.includes("roundtable") ||
    t.includes("advisory committee") ||
    t.includes("investor bulletin") ||
    t.includes("annual report") ||
    t.includes("strategic plan")
  );
}

function extractReleaseId(title: string, link: string, guid: string): string | null {
  const linkMatch = /litreleases\/lr-?(\d+)/i.exec(link) || /litrel(\d+)/i.exec(link);
  if (linkMatch?.[1]) return `LR-${linkMatch[1]}`;
  const adminMatch = /\/litigation\/admin\/.*?(\d{4}-\d+)/i.exec(link);
  if (adminMatch?.[1]) return `ADM-${adminMatch[1]}`;
  const pressMatch = /press[-_]?release\/(\d+-\d+)/i.exec(link) || /(\d{4}-\d+)\.htm/.exec(link);
  if (pressMatch?.[1]) return `PR-${pressMatch[1]}`;
  if (guid && guid.length < 200) return `GUID-${hashString(guid)}`;
  if (title) return `TITLE-${hashString(title)}`;
  return null;
}

function extractRespondent(title: string, description: string | undefined): string {
  const vsMatch = /SEC\s+(?:charges|sues|files\s+charges\s+against|obtains\s+emergency\s+relief\s+against|settles\s+charges\s+with|orders)\s+(.+?)\s+(?:for|with|over|in connection|alleg|and|,|\.|$)/i.exec(
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
