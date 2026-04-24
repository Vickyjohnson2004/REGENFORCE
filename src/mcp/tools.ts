/**
 * Tool definitions for the REGENFORCE MCP server.
 *
 * Conventions:
 *   - `outputSchema` root is ALWAYS `type: "object"` per the MCP spec. See
 *     https://docs.ctxprotocol.com/guides/build-tools#outputschema-root-must-be-type-object
 *   - `_meta` declares Context surface, query eligibility, latency class,
 *     execute pricing ($0.001/call) and rate-limit hints. Query-mode billing
 *     is set by the listing response price ($0.10/response).
 *   - Every property carries a description so the Context runtime does not
 *     have to guess snake_case vs camelCase.
 */

import { AGENCIES, CANONICAL_ACTION_TYPES, CANONICAL_STATUSES } from "../types.js";

const AGENCY_ENUM = [...AGENCIES] as string[];
const ACTION_TYPE_ENUM = [...CANONICAL_ACTION_TYPES] as string[];
const STATUS_ENUM = [...CANONICAL_STATUSES] as string[];

const DEFAULT_EXECUTE_PRICE = "0.001";

const ACTION_ITEM_SCHEMA = {
  type: "object",
  description: "A single normalized enforcement action.",
  properties: {
    actionId: {
      type: "string",
      description: "Stable canonical identifier, formatted as `${AGENCY}:${agencySpecificId}`.",
    },
    agency: {
      type: "string",
      enum: AGENCY_ENUM,
      description: "Agency that published the enforcement action.",
    },
    actionType: {
      type: "string",
      enum: ACTION_TYPE_ENUM,
      description: "Canonical action type mapped from the agency-specific taxonomy.",
    },
    rawActionType: {
      type: ["string", "null"],
      description: "Original action-type phrasing exactly as published by the agency (preserved for audit).",
    },
    status: {
      type: "string",
      enum: STATUS_ENUM,
      description: "Canonical status (filed, settled, pending, final_order, dismissed, unknown).",
    },
    rawStatus: {
      type: ["string", "null"],
      description: "Original status phrasing from the source agency.",
    },
    actionDate: {
      type: ["string", "null"],
      description: "ISO 8601 date (YYYY-MM-DD) when the action was filed / settled / published.",
    },
    respondent: {
      type: "string",
      description: "Primary respondent / subject of the enforcement action.",
    },
    respondents: {
      type: "array",
      items: { type: "string" },
      description: "All named respondents (companies and individuals).",
    },
    penaltyAmount: {
      type: ["number", "null"],
      description: "Total monetary penalty in USD across all components (fines + disgorgement + restitution).",
    },
    penaltyCurrency: {
      type: "string",
      description: "Always USD. All penalties are USD-normalized at ingestion.",
    },
    penaltyBreakdown: {
      type: ["array", "null"],
      description: "Decomposition of total penalty across civil_penalty, disgorgement, restitution, and prejudgment_interest.",
      items: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Component amount in USD." },
          currency: { type: "string", description: "Always USD." },
          type: {
            type: "string",
            enum: ["civil_penalty", "disgorgement", "restitution", "prejudgment_interest", "other"],
            description: "Component classification.",
          },
        },
        required: ["amount", "currency", "type"],
      },
    },
    allegations: {
      type: ["string", "null"],
      description: "Short description of the alleged violations or conduct.",
    },
    title: {
      type: ["string", "null"],
      description: "Source-provided title, press-release headline or docket caption.",
    },
    summary: {
      type: ["string", "null"],
      description: "Source-provided summary or press-release body text.",
    },
    documentUrl: {
      type: ["string", "null"],
      description: "URL to the authoritative source document or press release.",
    },
    entityKey: {
      type: "string",
      description: "Normalized fuzzy-match key used to link related actions across agencies.",
    },
    entityMatchScore: {
      type: ["number", "null"],
      description: "Similarity score vs the search entity, 0.0 – 1.0. Populated only for entity-based searches.",
    },
    entityMatchConfidence: {
      type: ["string", "null"],
      enum: ["high", "medium", "low", null],
      description: "Bucketed confidence: high (>=0.90), medium (>=0.70), low (<0.70). Populated only for entity-based searches.",
    },
    provenance: {
      type: "object",
      description:
        "Field-level provenance tagging. Each key in `fieldOrigin` tells you whether the field was observed (from source), normalized (transformed), inferred (derived from text), or unknown (not available from this source).",
      properties: {
        source: { type: "string", description: "Short identifier of the upstream data source." },
        sourceUrl: { type: ["string", "null"], description: "URL of the upstream source." },
        fetchedAt: { type: "string", description: "ISO 8601 timestamp the record was fetched." },
        sourceUpdatedAt: { type: ["string", "null"], description: "ISO 8601 timestamp the source last updated the record (when known)." },
        fieldOrigin: {
          type: "object",
          description: "Map of field name -> origin tag (observed | normalized | inferred | unknown).",
          additionalProperties: { type: "string" },
        },
      },
      required: ["source", "fetchedAt", "fieldOrigin"],
    },
  },
  required: ["actionId", "agency", "actionType", "status", "respondent", "respondents", "entityKey", "penaltyCurrency", "provenance"],
} as const;

const RISK_SUMMARY_SCHEMA = {
  type: "object",
  description:
    "Risk-profile rollup computed across all returned actions. Use this for a premium answer: it captures total penalty exposure, agency breadth, action-type distribution and the most severe single action.",
  properties: {
    totalActionsFound: {
      type: "number",
      description: "Count of enforcement actions returned in this response.",
    },
    agenciesCovered: {
      type: "array",
      items: { type: "string", enum: AGENCY_ENUM },
      description: "Distinct agencies that published at least one of the returned actions.",
    },
    totalPenaltyUsd: {
      type: "number",
      description: "Sum of penaltyAmount across all returned actions, in USD.",
    },
    largestPenalty: {
      type: ["object", "null"],
      description: "The single action with the largest penalty amount, when penalty data is available.",
      properties: {
        actionId: { type: "string" },
        agency: { type: "string" },
        penaltyAmount: { type: "number" },
        respondent: { type: "string" },
        actionDate: { type: ["string", "null"] },
      },
    },
    actionTypeCounts: {
      type: "object",
      description: "Count of returned actions per canonical action type.",
      additionalProperties: { type: "number" },
    },
    statusCounts: {
      type: "object",
      description: "Count of returned actions per canonical status.",
      additionalProperties: { type: "number" },
    },
    dateRange: {
      type: "object",
      description: "Earliest and latest actionDate across the returned actions.",
      properties: {
        earliest: { type: ["string", "null"] },
        latest: { type: ["string", "null"] },
      },
    },
    narrative: {
      type: "string",
      description: "Human-readable summary of the entity's regulatory exposure, suitable for direct inclusion in a compliance memo.",
    },
  },
  required: [
    "totalActionsFound",
    "agenciesCovered",
    "totalPenaltyUsd",
    "actionTypeCounts",
    "statusCounts",
    "dateRange",
    "narrative",
  ],
} as const;

const ENTITY_MATCH_ARRAY_SCHEMA = {
  type: "array",
  description:
    "Top candidate entities that matched the search string. Includes the canonical respondent names and similarity scores so the caller can judge whether the fuzzy match was tight (high) or loose (low).",
  items: {
    type: "object",
    properties: {
      respondent: { type: "string" },
      entityKey: { type: "string" },
      bestScore: { type: "number", description: "Similarity score (0.0 – 1.0)." },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Bucketed confidence (high >= 0.9, medium >= 0.7, low < 0.7).",
      },
      actionCount: { type: "number", description: "Number of enforcement actions tied to this entity." },
    },
    required: ["respondent", "entityKey", "bestScore", "confidence", "actionCount"],
  },
} as const;

const METADATA_SCHEMA = {
  type: "object",
  description: "Response freshness and data-coverage metadata.",
  properties: {
    generatedAt: {
      type: "string",
      description: "ISO 8601 timestamp when this response was generated.",
    },
    sourceUpdatedAt: {
      type: ["string", "null"],
      description: "ISO 8601 timestamp of the most recent ingestion completion relevant to this query.",
    },
    dataFreshness: {
      type: "string",
      description: "Human-readable data freshness summary (e.g. 'ingested 3h ago').",
    },
    agencyCoverage: {
      type: "object",
      description: "Per-agency coverage info: earliest action, latest action, total actions currently ingested.",
      additionalProperties: {
        type: "object",
        properties: {
          earliestAction: { type: ["string", "null"] },
          latestAction: { type: ["string", "null"] },
          totalActions: { type: "number" },
          lastIngestedAt: { type: ["string", "null"] },
        },
      },
    },
  },
  required: ["generatedAt", "dataFreshness"],
} as const;

const RATE_LIMIT_META = {
  maxRequestsPerMinute: 600,
  maxConcurrency: 10,
  cooldownMs: 0,
  notes:
    "Served from local Postgres cache of pre-ingested enforcement data. No upstream agency calls are made at request time.",
} as const;

export const TOOLS = [
  // =========================================================================
  // QUERY MODE — premium answers
  // =========================================================================
  {
    name: "search_enforcement_by_entity",
    description:
      "Search all six US financial regulators (SEC, CFPB, FTC, FINRA, FinCEN, OCC) for every enforcement action involving a given company or individual. Returns a unified normalized schema with entity-match confidence, penalty totals, action-type breakdown, and a narrative risk summary. This is the premium answer that replaces manually checking six agency websites. Use for compliance due-diligence, partner screening, or pre-investment regulatory exposure checks.",
    _meta: {
      surface: "both",
      queryEligible: true,
      latencyClass: "instant",
      pricing: { executeUsd: DEFAULT_EXECUTE_PRICE },
      rateLimit: RATE_LIMIT_META,
    },
    inputSchema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          description: "Company or individual name to search for. Fuzzy-matched across agencies (e.g. 'Wise', 'TransferWise', 'Wise US Inc' all resolve together).",
          examples: ["Wise", "Robinhood", "Bank of America", "Binance", "Coinbase", "Wells Fargo"],
        },
        agencies: {
          type: "array",
          items: { type: "string", enum: AGENCY_ENUM },
          description: "Restrict to specific agencies. Omit or pass all six to search the full regulatory landscape.",
          default: [...AGENCIES],
          examples: [["SEC", "CFPB"], [...AGENCIES]],
        },
        minConfidence: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Minimum fuzzy-match confidence bucket. `high` returns only tight exact / near-exact matches; `medium` is the default for cross-agency entity resolution.",
          default: "medium",
        },
        limit: {
          type: "number",
          description: "Max number of individual actions to return (1-200). Rollup counts always reflect the full match set.",
          default: 25,
          minimum: 1,
          maximum: 200,
        },
        fromDate: {
          type: "string",
          description: "Earliest ISO date (inclusive) to include.",
          examples: ["2020-01-01"],
        },
        toDate: {
          type: "string",
          description: "Latest ISO date (inclusive) to include.",
        },
      },
      required: ["entity"],
    },
    outputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "The query entity, echoed back." },
        riskSummary: RISK_SUMMARY_SCHEMA,
        actions: {
          type: "array",
          description: "Normalized enforcement actions, sorted by entity-match score then date (descending).",
          items: ACTION_ITEM_SCHEMA,
        },
        entityMatches: ENTITY_MATCH_ARRAY_SCHEMA,
        metadata: METADATA_SCHEMA,
      },
      required: ["entity", "riskSummary", "actions", "entityMatches", "metadata"],
    },
  },

  {
    name: "get_enforcement_risk_profile",
    description:
      "Produce a standalone regulatory-risk profile for an entity: total penalty exposure, agency breadth, pattern of repeat violations over time, and a plain-English narrative suitable for a compliance memo. This is the one-shot 'instant cross-agency profile' query used in pre-investment and partner-due-diligence workflows.",
    _meta: {
      surface: "both",
      queryEligible: true,
      latencyClass: "instant",
      pricing: { executeUsd: DEFAULT_EXECUTE_PRICE },
      rateLimit: RATE_LIMIT_META,
    },
    inputSchema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          description: "Company or individual to profile.",
          examples: ["Wise", "SoFi", "Block Inc", "Kraken"],
        },
        lookbackYears: {
          type: "number",
          description: "How many years of history to include. Defaults to 10.",
          default: 10,
          examples: [3, 5, 10, 20],
        },
      },
      required: ["entity"],
    },
    outputSchema: {
      type: "object",
      properties: {
        entity: { type: "string" },
        resolvedRespondent: {
          type: ["string", "null"],
          description: "The best-matching canonical respondent name, or null if no match.",
        },
        matchConfidence: {
          type: ["string", "null"],
          enum: ["high", "medium", "low", null],
        },
        riskSummary: RISK_SUMMARY_SCHEMA,
        agencyBreakdown: {
          type: "array",
          description: "Per-agency rollup for this entity.",
          items: {
            type: "object",
            properties: {
              agency: { type: "string", enum: AGENCY_ENUM },
              actionCount: { type: "number" },
              totalPenaltyUsd: { type: "number" },
              mostRecentActionDate: { type: ["string", "null"] },
            },
            required: ["agency", "actionCount", "totalPenaltyUsd"],
          },
        },
        timeline: {
          type: "array",
          description: "Chronological list of the entity's enforcement actions (up to 50 most recent), suitable for rendering a timeline.",
          items: ACTION_ITEM_SCHEMA,
        },
        entityMatches: ENTITY_MATCH_ARRAY_SCHEMA,
        metadata: METADATA_SCHEMA,
      },
      required: ["entity", "riskSummary", "agencyBreakdown", "timeline", "entityMatches", "metadata"],
    },
  },

  {
    name: "search_enforcement_by_topic",
    description:
      "Search enforcement actions across all agencies by topic / violation type (e.g. AML/KYC, consumer protection, market manipulation, BSA violations, unfair practices). Returns the most relevant actions with a peer-enforcement summary showing which agencies are most active on this topic and the typical penalty range. Useful for regulatory-trend analysis and peer benchmarking.",
    _meta: {
      surface: "both",
      queryEligible: true,
      latencyClass: "instant",
      pricing: { executeUsd: DEFAULT_EXECUTE_PRICE },
      rateLimit: RATE_LIMIT_META,
    },
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Free-text topic or violation keyword. Matches against respondent, title, allegations and summary.",
          examples: [
            "AML KYC",
            "consumer redress",
            "market manipulation",
            "BSA violations",
            "mortgage servicing",
            "payday lending",
            "crypto",
          ],
        },
        agencies: {
          type: "array",
          items: { type: "string", enum: AGENCY_ENUM },
          description: "Optional agency filter.",
        },
        actionTypes: {
          type: "array",
          items: { type: "string", enum: ACTION_TYPE_ENUM },
          description: "Optional canonical action-type filter.",
        },
        fromDate: { type: "string", description: "Earliest ISO date (inclusive)." },
        toDate: { type: "string", description: "Latest ISO date (inclusive)." },
        limit: { type: "number", default: 25, minimum: 1, maximum: 200 },
      },
      required: ["topic"],
    },
    outputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        totalMatching: { type: "number", description: "Total actions matching the topic query (unpaginated count)." },
        peerSummary: {
          type: "object",
          description: "Peer-enforcement summary for this topic.",
          properties: {
            agenciesActive: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  agency: { type: "string", enum: AGENCY_ENUM },
                  actionCount: { type: "number" },
                  totalPenaltyUsd: { type: "number" },
                },
                required: ["agency", "actionCount", "totalPenaltyUsd"],
              },
            },
            medianPenaltyUsd: { type: ["number", "null"] },
            averagePenaltyUsd: { type: ["number", "null"] },
            totalPenaltyUsd: { type: "number" },
          },
          required: ["agenciesActive", "totalPenaltyUsd"],
        },
        actions: {
          type: "array",
          items: ACTION_ITEM_SCHEMA,
        },
        metadata: METADATA_SCHEMA,
      },
      required: ["topic", "totalMatching", "peerSummary", "actions", "metadata"],
    },
  },

  // =========================================================================
  // EXECUTE MODE — normalized primitives
  // =========================================================================
  {
    name: "list_enforcement_actions",
    description:
      "Paginated normalized list of enforcement actions across any combination of agencies, action types, statuses, date range, and penalty range. Use this as the canonical primitive when building downstream agent workflows (e.g. iterate all CFPB consent orders with penalty > $1M in 2025).",
    _meta: {
      surface: "both",
      queryEligible: true,
      latencyClass: "instant",
      pricing: { executeUsd: DEFAULT_EXECUTE_PRICE },
      rateLimit: RATE_LIMIT_META,
    },
    inputSchema: {
      type: "object",
      properties: {
        agencies: {
          type: "array",
          items: { type: "string", enum: AGENCY_ENUM },
          description: "Agencies to include. Omit for all six.",
          examples: [["CFPB"], ["SEC", "FINRA"]],
        },
        actionTypes: {
          type: "array",
          items: { type: "string", enum: ACTION_TYPE_ENUM },
          description: "Canonical action types to include.",
        },
        statuses: {
          type: "array",
          items: { type: "string", enum: STATUS_ENUM },
          description: "Canonical statuses to include.",
        },
        fromDate: { type: "string", description: "Earliest ISO date (inclusive)." },
        toDate: { type: "string", description: "Latest ISO date (inclusive)." },
        minPenalty: { type: "number", description: "Minimum total penalty in USD." },
        maxPenalty: { type: "number", description: "Maximum total penalty in USD." },
        fullText: {
          type: "string",
          description: "Full-text search across respondent, title, allegations and summary fields.",
          examples: ["AML", "crypto", "elder fraud"],
        },
        limit: { type: "number", default: 50, minimum: 1, maximum: 200 },
        offset: { type: "number", default: 0, minimum: 0 },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        total: {
          type: "number",
          description: "Total matching rows (unpaginated). Use with limit/offset to iterate.",
        },
        actions: {
          type: "array",
          items: ACTION_ITEM_SCHEMA,
        },
        metadata: METADATA_SCHEMA,
      },
      required: ["total", "actions", "metadata"],
    },
  },
  {
    name: "get_enforcement_action",
    description:
      "Fetch a single normalized enforcement action by its canonical `actionId` (format `${AGENCY}:${agencySpecificId}`). Returns the full record including penalty breakdown and field-level provenance.",
    _meta: {
      surface: "both",
      queryEligible: true,
      latencyClass: "instant",
      pricing: { executeUsd: DEFAULT_EXECUTE_PRICE },
      rateLimit: RATE_LIMIT_META,
    },
    inputSchema: {
      type: "object",
      properties: {
        actionId: {
          type: "string",
          description: "Canonical action identifier, e.g. 'CFPB:2025-0042' or 'SEC:LR-26123'.",
          examples: ["SEC:LR-25790", "CFPB:2024-0019"],
        },
      },
      required: ["actionId"],
    },
    outputSchema: {
      type: "object",
      properties: {
        found: { type: "boolean", description: "True when the action was found." },
        action: {
          ...ACTION_ITEM_SCHEMA,
          description:
            "The normalized action when found. All fields are null / empty when `found` is false. See `found` to distinguish a miss from a data-gap.",
        },
        metadata: METADATA_SCHEMA,
      },
      required: ["found", "metadata"],
    },
  },
  {
    name: "resolve_entity",
    description:
      "Entity resolution primitive: given a free-form company or individual name, return the top matching canonical respondents across the enforcement dataset with confidence scores. Use this to disambiguate before calling `search_enforcement_by_entity`.",
    _meta: {
      surface: "both",
      queryEligible: true,
      latencyClass: "instant",
      pricing: { executeUsd: DEFAULT_EXECUTE_PRICE },
      rateLimit: RATE_LIMIT_META,
    },
    inputSchema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          description: "Free-form entity name to resolve.",
          examples: ["Wise", "Wells Fargo", "Binance Holdings", "Goldman"],
        },
        limit: { type: "number", default: 10, minimum: 1, maximum: 50 },
      },
      required: ["entity"],
    },
    outputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        matches: ENTITY_MATCH_ARRAY_SCHEMA,
        metadata: METADATA_SCHEMA,
      },
      required: ["query", "matches", "metadata"],
    },
  },
  {
    name: "get_agency_coverage",
    description:
      "Return per-agency coverage metadata: earliest / latest enforcement action dates currently in the dataset, total count per agency, and the timestamp of the last successful ingestion run. Use this to gauge freshness before synthesizing an answer.",
    _meta: {
      surface: "both",
      queryEligible: true,
      latencyClass: "instant",
      pricing: { executeUsd: DEFAULT_EXECUTE_PRICE },
      rateLimit: RATE_LIMIT_META,
    },
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    outputSchema: {
      type: "object",
      properties: {
        agencies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              agency: { type: "string", enum: AGENCY_ENUM },
              earliestAction: { type: ["string", "null"] },
              latestAction: { type: ["string", "null"] },
              totalActions: { type: "number" },
              lastIngestedAt: { type: ["string", "null"] },
              lastIngestStatus: { type: ["string", "null"] },
            },
            required: ["agency", "totalActions"],
          },
        },
        metadata: METADATA_SCHEMA,
      },
      required: ["agencies", "metadata"],
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];
