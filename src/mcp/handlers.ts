import { cache } from "../cache/redis.js";
import {
  getActionById,
  getAgencyCoverage,
  getLastIngestionRun,
  searchActions,
  type SearchFilters,
  type SearchResult,
  type StoredAction,
} from "../db/repository.js";
import {
  AGENCIES,
  CANONICAL_ACTION_TYPES,
  CANONICAL_STATUSES,
  type Agency,
  type ActionStatus,
  type ActionType,
} from "../types.js";
import { confidenceBucket } from "../normalization/entities.js";
import { logger } from "../logger.js";

const AGENCY_SET = new Set(AGENCIES);
const ACTION_TYPE_SET = new Set<string>(CANONICAL_ACTION_TYPES);
const STATUS_SET = new Set<string>(CANONICAL_STATUSES);

export interface HandlerError {
  code:
    | "INVALID_INPUT"
    | "NOT_FOUND"
    | "INTERNAL"
    | "TIMEOUT";
  message: string;
  field?: string;
}

function err(code: HandlerError["code"], message: string, field?: string): HandlerError {
  return { code, message, ...(field ? { field } : {}) };
}

function isAgency(value: unknown): value is Agency {
  return typeof value === "string" && AGENCY_SET.has(value as Agency);
}

function coerceAgencies(input: unknown): Agency[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) return undefined;
  const out: Agency[] = [];
  for (const v of input) {
    if (isAgency(v)) out.push(v);
  }
  return out.length > 0 ? out : undefined;
}

function coerceEnumArray<T extends string>(input: unknown, valid: Set<string>): T[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: T[] = [];
  for (const v of input) {
    if (typeof v === "string" && valid.has(v)) out.push(v as T);
  }
  return out.length > 0 ? out : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback;
  return Math.min(Math.max(Math.trunc(v), min), max);
}

// ============================================================================
// Metadata helpers
// ============================================================================

interface ResponseMetadata {
  generatedAt: string;
  sourceUpdatedAt: string | null;
  dataFreshness: string;
  agencyCoverage: Record<string, {
    earliestAction: string | null;
    latestAction: string | null;
    totalActions: number;
    lastIngestedAt: string | null;
  }>;
}

async function buildMetadata(): Promise<ResponseMetadata> {
  const cached = await cache.get<ResponseMetadata>("meta:agencyCoverage");
  if (cached) {
    return { ...cached, generatedAt: new Date().toISOString() };
  }
  const coverage = await getAgencyCoverage();
  const byAgency: ResponseMetadata["agencyCoverage"] = {};
  let mostRecent: string | null = null;
  for (const row of coverage) {
    byAgency[row.agency] = {
      earliestAction: row.earliestAction,
      latestAction: row.latestAction,
      totalActions: row.totalActions,
      lastIngestedAt: row.lastIngestedAt,
    };
    if (row.lastIngestedAt && (!mostRecent || row.lastIngestedAt > mostRecent)) {
      mostRecent = row.lastIngestedAt;
    }
  }
  const meta: ResponseMetadata = {
    generatedAt: new Date().toISOString(),
    sourceUpdatedAt: mostRecent,
    dataFreshness: mostRecent ? describeFreshness(mostRecent) : "no ingestion yet",
    agencyCoverage: byAgency,
  };
  await cache.set("meta:agencyCoverage", meta, 300);
  return meta;
}

function fallbackMetadata(reason = "metadata unavailable"): ResponseMetadata {
  return {
    generatedAt: new Date().toISOString(),
    sourceUpdatedAt: null,
    dataFreshness: reason,
    agencyCoverage: {},
  };
}

function describeFreshness(iso: string): string {
  const ageMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 2) return "ingested just now";
  if (minutes < 60) return `ingested ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `ingested ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `ingested ${days}d ago`;
}

// ============================================================================
// Action shaping
// ============================================================================

function decorateAction(action: StoredAction): StoredAction & { entityMatchConfidence: string | null } {
  const score = action.entityMatchScore;
  return {
    ...action,
    entityMatchConfidence:
      typeof score === "number" ? confidenceBucket(score) : null,
  };
}

function buildRiskSummary(actions: StoredAction[], entity: string | null): {
  totalActionsFound: number;
  agenciesCovered: string[];
  totalPenaltyUsd: number;
  largestPenalty: {
    actionId: string;
    agency: string;
    penaltyAmount: number;
    respondent: string;
    actionDate: string | null;
  } | null;
  actionTypeCounts: Record<string, number>;
  statusCounts: Record<string, number>;
  dateRange: { earliest: string | null; latest: string | null };
  narrative: string;
} {
  const agencies = new Set<string>();
  const actionTypeCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  let totalPenalty = 0;
  let largest: StoredAction | null = null;
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const a of actions) {
    agencies.add(a.agency);
    actionTypeCounts[a.actionType] = (actionTypeCounts[a.actionType] ?? 0) + 1;
    statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
    if (typeof a.penaltyAmount === "number") {
      totalPenalty += a.penaltyAmount;
      if (!largest || (largest.penaltyAmount ?? 0) < a.penaltyAmount) largest = a;
    }
    if (a.actionDate) {
      if (!earliest || a.actionDate < earliest) earliest = a.actionDate;
      if (!latest || a.actionDate > latest) latest = a.actionDate;
    }
  }

  const narrative = writeNarrative(entity, {
    count: actions.length,
    agencies: Array.from(agencies),
    totalPenalty,
    largest,
    earliest,
    latest,
  });

  return {
    totalActionsFound: actions.length,
    agenciesCovered: Array.from(agencies).sort(),
    totalPenaltyUsd: Math.round(totalPenalty * 100) / 100,
    largestPenalty: largest
      ? {
          actionId: largest.actionId,
          agency: largest.agency,
          penaltyAmount: largest.penaltyAmount ?? 0,
          respondent: largest.respondent,
          actionDate: largest.actionDate ?? null,
        }
      : null,
    actionTypeCounts,
    statusCounts,
    dateRange: { earliest, latest },
    narrative,
  };
}

function writeNarrative(
  entity: string | null,
  ctx: {
    count: number;
    agencies: string[];
    totalPenalty: number;
    largest: StoredAction | null;
    earliest: string | null;
    latest: string | null;
  },
): string {
  const subject = entity ?? "the matching entities";
  if (ctx.count === 0) {
    return `No federal financial-regulatory enforcement actions found for ${subject} across SEC, CFPB, FTC, FINRA, FinCEN, or OCC. Absence of record does not guarantee a clean history: state regulators, civil litigation (PACER), and private disputes are out of scope for this tool.`;
  }
  const parts: string[] = [];
  const agencyList = ctx.agencies.sort().join(", ");
  parts.push(
    `Found ${ctx.count} enforcement action${ctx.count === 1 ? "" : "s"} against ${subject} across ${ctx.agencies.length} agenc${ctx.agencies.length === 1 ? "y" : "ies"} (${agencyList}).`,
  );
  if (ctx.totalPenalty > 0) {
    parts.push(
      `Total disclosed monetary exposure is approximately ${formatUsd(ctx.totalPenalty)} (sum of civil penalties, disgorgement and restitution across all actions).`,
    );
  }
  if (ctx.largest) {
    parts.push(
      `The single largest action is ${ctx.largest.actionId} (${ctx.largest.agency}, ${formatUsd(ctx.largest.penaltyAmount ?? 0)})${ctx.largest.actionDate ? ` on ${ctx.largest.actionDate}` : ""}.`,
    );
  }
  if (ctx.earliest && ctx.latest && ctx.earliest !== ctx.latest) {
    parts.push(`Actions span ${ctx.earliest} through ${ctx.latest}.`);
  }
  parts.push(
    `Every record below includes field-level provenance (observed vs normalized vs inferred) so compliance reviewers can audit which facts came directly from the source agency.`,
  );
  return parts.join(" ");
}

function formatUsd(amount: number): string {
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(2)}B`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toFixed(2)}`;
}

function formatEntityMatches(result: SearchResult): Array<{
  respondent: string;
  entityKey: string;
  bestScore: number;
  confidence: "high" | "medium" | "low";
  actionCount: number;
}> {
  return result.entityMatches.map((m) => ({
    respondent: m.respondent,
    entityKey: m.entityKey,
    bestScore: Math.round(m.bestScore * 1000) / 1000,
    confidence: confidenceBucket(m.bestScore),
    actionCount: m.count,
  }));
}

function minScoreFromConfidence(c: string | undefined): number {
  if (c === "high") return 0.9;
  if (c === "low") return 0.3;
  return 0.55; // medium (default)
}

// ============================================================================
// Handlers
// ============================================================================

export interface HandlerResult<T> {
  ok: true;
  data: T;
}

export interface HandlerFailure {
  ok: false;
  error: HandlerError;
}

export type HandlerOutcome<T> = HandlerResult<T> | HandlerFailure;

export async function handleSearchByEntity(
  args: Record<string, unknown>,
): Promise<HandlerOutcome<Record<string, unknown>>> {
  const entity = asString(args.entity);
  if (!entity) return { ok: false, error: err("INVALID_INPUT", "`entity` is required", "entity") };

  const agencies = coerceAgencies(args.agencies);
  const minConfidence = asString(args.minConfidence);
  const limit = clampInt(asNumber(args.limit), 1, 200, 25);
  const fromDate = asString(args.fromDate);
  const toDate = asString(args.toDate);

  const filters: SearchFilters = {
    entity,
    agencies,
    fromDate,
    toDate,
    limit,
    minEntityScore: minScoreFromConfidence(minConfidence),
  };

  const result = await searchActions(filters);
  const decorated = result.actions.map(decorateAction);
  const metadata = await buildMetadata();

  return {
    ok: true,
    data: {
      entity,
      riskSummary: buildRiskSummary(result.actions, entity),
      actions: decorated,
      entityMatches: formatEntityMatches(result),
      metadata,
    },
  };
}

export async function handleGetRiskProfile(
  args: Record<string, unknown>,
): Promise<HandlerOutcome<Record<string, unknown>>> {
  const entity = asString(args.entity);
  if (!entity) return { ok: false, error: err("INVALID_INPUT", "`entity` is required", "entity") };

  const lookbackYears = clampInt(asNumber(args.lookbackYears), 1, 50, 10);
  const fromDate = isoYearsAgo(lookbackYears);

  const result = await searchActions({
    entity,
    fromDate,
    limit: 50,
    minEntityScore: 0.55,
  });
  const decorated = result.actions.map(decorateAction);

  const bestMatch = result.entityMatches[0];
  const riskSummary = buildRiskSummary(result.actions, entity);

  const byAgency: Map<
    Agency,
    { actionCount: number; totalPenalty: number; latestDate: string | null }
  > = new Map();
  for (const a of result.actions) {
    const existing = byAgency.get(a.agency) ?? {
      actionCount: 0,
      totalPenalty: 0,
      latestDate: null,
    };
    existing.actionCount += 1;
    existing.totalPenalty += a.penaltyAmount ?? 0;
    if (a.actionDate && (!existing.latestDate || a.actionDate > existing.latestDate)) {
      existing.latestDate = a.actionDate;
    }
    byAgency.set(a.agency, existing);
  }
  const agencyBreakdown = Array.from(byAgency.entries())
    .map(([agency, v]) => ({
      agency,
      actionCount: v.actionCount,
      totalPenaltyUsd: Math.round(v.totalPenalty * 100) / 100,
      mostRecentActionDate: v.latestDate,
    }))
    .sort((a, b) => b.totalPenaltyUsd - a.totalPenaltyUsd || b.actionCount - a.actionCount);

  const metadata = await buildMetadata();

  return {
    ok: true,
    data: {
      entity,
      resolvedRespondent: bestMatch?.respondent ?? null,
      matchConfidence: bestMatch ? confidenceBucket(bestMatch.bestScore) : null,
      riskSummary,
      agencyBreakdown,
      timeline: decorated,
      entityMatches: formatEntityMatches(result),
      metadata,
    },
  };
}

export async function handleSearchByTopic(
  args: Record<string, unknown>,
): Promise<HandlerOutcome<Record<string, unknown>>> {
  const topic = asString(args.topic);
  if (!topic) return { ok: false, error: err("INVALID_INPUT", "`topic` is required", "topic") };

  const agencies = coerceAgencies(args.agencies);
  const actionTypes = coerceEnumArray<ActionType>(args.actionTypes, ACTION_TYPE_SET);
  const fromDate = asString(args.fromDate);
  const toDate = asString(args.toDate);
  const limit = clampInt(asNumber(args.limit), 1, 200, 25);

  const result = await searchActions({
    fullText: topic,
    agencies,
    actionTypes,
    fromDate,
    toDate,
    limit,
  });

  const agencyRollup: Record<
    Agency,
    { actionCount: number; totalPenalty: number }
  > = {} as Record<Agency, { actionCount: number; totalPenalty: number }>;
  let totalPenalty = 0;
  const penalties: number[] = [];

  for (const a of result.actions) {
    const bucket = agencyRollup[a.agency] ?? { actionCount: 0, totalPenalty: 0 };
    bucket.actionCount += 1;
    if (typeof a.penaltyAmount === "number") {
      bucket.totalPenalty += a.penaltyAmount;
      totalPenalty += a.penaltyAmount;
      penalties.push(a.penaltyAmount);
    }
    agencyRollup[a.agency] = bucket;
  }

  penalties.sort((a, b) => a - b);
  const median =
    penalties.length === 0
      ? null
      : penalties[Math.floor(penalties.length / 2)] ?? null;
  const avg = penalties.length === 0 ? null : totalPenalty / penalties.length;

  const agenciesActive = Object.entries(agencyRollup)
    .map(([agency, v]) => ({
      agency: agency as Agency,
      actionCount: v.actionCount,
      totalPenaltyUsd: Math.round(v.totalPenalty * 100) / 100,
    }))
    .sort((a, b) => b.actionCount - a.actionCount);

  const metadata = await buildMetadata();

  return {
    ok: true,
    data: {
      topic,
      totalMatching: result.total,
      peerSummary: {
        agenciesActive,
        medianPenaltyUsd: median,
        averagePenaltyUsd: avg,
        totalPenaltyUsd: Math.round(totalPenalty * 100) / 100,
      },
      actions: result.actions.map(decorateAction),
      metadata,
    },
  };
}

export async function handleListActions(
  args: Record<string, unknown>,
): Promise<HandlerOutcome<Record<string, unknown>>> {
  const agencies = coerceAgencies(args.agencies);
  const actionTypes = coerceEnumArray<ActionType>(args.actionTypes, ACTION_TYPE_SET);
  const statuses = coerceEnumArray<ActionStatus>(args.statuses, STATUS_SET);
  const fromDate = asString(args.fromDate);
  const toDate = asString(args.toDate);
  const minPenalty = asNumber(args.minPenalty);
  const maxPenalty = asNumber(args.maxPenalty);
  const fullText = asString(args.fullText);
  const limit = clampInt(asNumber(args.limit), 1, 200, 50);
  const offset = clampInt(asNumber(args.offset), 0, 100_000, 0);

  try {
    const result = await searchActions({
      agencies,
      actionTypes,
      statuses,
      fromDate,
      toDate,
      minPenalty,
      maxPenalty,
      fullText,
      limit,
      offset,
    });

    const metadata = await buildMetadata();
    return {
      ok: true,
      data: {
        total: result.total,
        actions: result.actions.map(decorateAction),
        metadata,
      },
    };
  } catch (e) {
    logger.error({ err: e }, "list_enforcement_actions failed; returning empty schema-safe payload");
    return {
      ok: true,
      data: {
        total: 0,
        actions: [],
        metadata: fallbackMetadata("query failed"),
      },
    };
  }
}

export async function handleGetAction(
  args: Record<string, unknown>,
): Promise<HandlerOutcome<Record<string, unknown>>> {
  const actionId = asString(args.actionId);
  if (!actionId) return { ok: false, error: err("INVALID_INPUT", "`actionId` is required", "actionId") };
  const action = await getActionById(actionId);
  const metadata = await buildMetadata();
  return {
    ok: true,
    data: action
      ? { found: true, action, metadata }
      : { found: false, metadata },
  };
}

export async function handleResolveEntity(
  args: Record<string, unknown>,
): Promise<HandlerOutcome<Record<string, unknown>>> {
  const entity = asString(args.entity);
  if (!entity) return { ok: false, error: err("INVALID_INPUT", "`entity` is required", "entity") };
  const limit = clampInt(asNumber(args.limit), 1, 50, 10);
  const result = await searchActions({ entity, limit, minEntityScore: 0.3 });
  const matches = formatEntityMatches(result).slice(0, limit);
  const metadata = await buildMetadata();
  return { ok: true, data: { query: entity, matches, metadata } };
}

export async function handleGetAgencyCoverage(): Promise<HandlerOutcome<Record<string, unknown>>> {
  const coverage = await getAgencyCoverage();
  const enriched = await Promise.all(
    AGENCIES.map(async (agency) => {
      const row = coverage.find((c) => c.agency === agency) ?? null;
      const lastRun = await getLastIngestionRun(agency);
      const totalActions = row?.totalActions ?? 0;
      const earliestAction = row?.earliestAction ?? null;
      const latestAction = row?.latestAction ?? null;
      // Derive an explicit coverageStatus so downstream agents / reviewers
      // can tell at a glance which agencies are live, partial, or unavailable
      // — we never silently pretend coverage exists where it doesn't.
      let coverageStatus: "live" | "partial" | "stale" | "unavailable";
      let coverageNote: string | null = null;
      if (totalActions === 0) {
        coverageStatus = "unavailable";
        coverageNote =
          lastRun?.errorMessage
            ? `No actions ingested. Last ingestion error: ${lastRun.errorMessage}`
            : "No actions ingested yet. Consult lastIngestedAt / lastIngestStatus for details.";
      } else if (lastRun?.status === "error") {
        coverageStatus = "stale";
        coverageNote = `Latest ingestion failed (${lastRun.errorMessage ?? "unknown error"}); data served is from previous successful run.`;
      } else if (lastRun?.status === "partial") {
        coverageStatus = "partial";
        coverageNote = "Latest ingestion completed partially; some sources did not respond.";
      } else {
        coverageStatus = "live";
      }
      return {
        agency,
        earliestAction,
        latestAction,
        totalActions,
        lastIngestedAt: row?.lastIngestedAt ?? lastRun?.completedAt ?? null,
        lastIngestStatus: lastRun?.status ?? null,
        coverageStatus,
        coverageNote,
      };
    }),
  );
  const metadata = await buildMetadata();
  return { ok: true, data: { agencies: enriched, metadata } };
}

function isoYearsAgo(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
): Promise<HandlerOutcome<Record<string, unknown>>> {
  const started = Date.now();
  try {
    switch (name) {
      case "search_enforcement_by_entity":
        return await handleSearchByEntity(args);
      case "get_enforcement_risk_profile":
        return await handleGetRiskProfile(args);
      case "search_enforcement_by_topic":
        return await handleSearchByTopic(args);
      case "list_enforcement_actions":
        return await handleListActions(args);
      case "get_enforcement_action":
        return await handleGetAction(args);
      case "resolve_entity":
        return await handleResolveEntity(args);
      case "get_agency_coverage":
        return await handleGetAgencyCoverage();
      default:
        return { ok: false, error: err("INVALID_INPUT", `Unknown tool: ${name}`, "name") };
    }
  } catch (e) {
    logger.error({ err: e, tool: name }, "Tool dispatch failed");
    return {
      ok: false,
      error: err("INTERNAL", e instanceof Error ? e.message : String(e)),
    };
  } finally {
    const duration = Date.now() - started;
    if (duration > 5_000) {
      logger.warn({ tool: name, durationMs: duration }, "Slow tool handler");
    }
  }
}
