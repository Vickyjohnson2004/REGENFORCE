import { pool } from "./client.js";
import type {
  Agency,
  ActionStatus,
  ActionType,
  NormalizedAction,
} from "../types.js";
import { normalizeEntityKey } from "../normalization/entities.js";

export interface SearchFilters {
  entity?: string;
  agencies?: Agency[];
  actionTypes?: ActionType[];
  statuses?: ActionStatus[];
  minPenalty?: number;
  maxPenalty?: number;
  fromDate?: string;
  toDate?: string;
  fullText?: string;
  limit?: number;
  offset?: number;
  /** Approx minimum fuzzy match score for entity resolution (0.0 – 1.0). */
  minEntityScore?: number;
}

export interface SearchResult {
  actions: StoredAction[];
  total: number;
  entityMatches: Array<{
    respondent: string;
    entityKey: string;
    bestScore: number;
    count: number;
  }>;
}

export interface StoredAction extends NormalizedAction {
  /** Similarity score vs the search entity, 0.0 if entity search not used. */
  entityMatchScore?: number;
}

export async function upsertAction(action: NormalizedAction): Promise<"inserted" | "updated"> {
  const result = await pool.query<{ inserted: boolean }>(
    `
    INSERT INTO enforcement_actions (
      action_id, agency, action_type, raw_action_type, status, raw_status,
      action_date, respondent, respondents, penalty_amount, penalty_currency,
      penalty_breakdown, allegations, title, summary, document_url,
      entity_key, provenance, raw_payload, fetched_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,NOW(),NOW()
    )
    ON CONFLICT (action_id) DO UPDATE SET
      agency           = EXCLUDED.agency,
      action_type      = EXCLUDED.action_type,
      raw_action_type  = EXCLUDED.raw_action_type,
      status           = EXCLUDED.status,
      raw_status       = EXCLUDED.raw_status,
      action_date      = EXCLUDED.action_date,
      respondent       = EXCLUDED.respondent,
      respondents      = EXCLUDED.respondents,
      penalty_amount   = EXCLUDED.penalty_amount,
      penalty_currency = EXCLUDED.penalty_currency,
      penalty_breakdown= EXCLUDED.penalty_breakdown,
      allegations      = EXCLUDED.allegations,
      title            = EXCLUDED.title,
      summary          = EXCLUDED.summary,
      document_url     = EXCLUDED.document_url,
      entity_key       = EXCLUDED.entity_key,
      provenance       = EXCLUDED.provenance,
      raw_payload      = EXCLUDED.raw_payload,
      updated_at       = NOW()
    RETURNING (xmax = 0) AS inserted
    `,
    [
      action.actionId,
      action.agency,
      action.actionType,
      action.rawActionType ?? null,
      action.status,
      action.rawStatus ?? null,
      action.actionDate ?? null,
      action.respondent,
      JSON.stringify(action.respondents),
      action.penaltyAmount ?? null,
      action.penaltyCurrency ?? "USD",
      action.penaltyBreakdown ? JSON.stringify(action.penaltyBreakdown) : null,
      action.allegations ?? null,
      action.title ?? null,
      action.summary ?? null,
      action.documentUrl ?? null,
      action.entityKey,
      JSON.stringify(action.provenance),
      action.rawPayload !== undefined ? JSON.stringify(action.rawPayload) : null,
    ],
  );
  return result.rows[0]?.inserted ? "inserted" : "updated";
}

interface ActionRow {
  action_id: string;
  agency: Agency;
  action_type: ActionType;
  raw_action_type: string | null;
  status: ActionStatus;
  raw_status: string | null;
  action_date: Date | null;
  respondent: string;
  respondents: string[] | null;
  penalty_amount: string | null;
  penalty_currency: string | null;
  penalty_breakdown: unknown;
  allegations: string | null;
  title: string | null;
  summary: string | null;
  document_url: string | null;
  entity_key: string;
  provenance: NormalizedAction["provenance"];
  entity_match_score: string | number | null;
  total_count: string | number | null;
}

function rowToAction(row: ActionRow): StoredAction {
  const matchScoreRaw = row.entity_match_score;
  const matchScore =
    matchScoreRaw === null || matchScoreRaw === undefined
      ? undefined
      : Number(matchScoreRaw);

  return {
    actionId: row.action_id,
    agency: row.agency,
    actionType: row.action_type,
    rawActionType: row.raw_action_type ?? undefined,
    status: row.status,
    rawStatus: row.raw_status ?? undefined,
    actionDate: row.action_date
      ? row.action_date.toISOString().slice(0, 10)
      : undefined,
    respondent: row.respondent,
    respondents: Array.isArray(row.respondents) ? row.respondents : [],
    penaltyAmount:
      row.penalty_amount === null ? undefined : Number(row.penalty_amount),
    penaltyCurrency: "USD",
    penaltyBreakdown: (row.penalty_breakdown as NormalizedAction["penaltyBreakdown"]) ?? undefined,
    allegations: row.allegations ?? undefined,
    title: row.title ?? undefined,
    summary: row.summary ?? undefined,
    documentUrl: row.document_url ?? undefined,
    entityKey: row.entity_key,
    provenance: row.provenance,
    entityMatchScore: matchScore ?? undefined,
  };
}

export async function searchActions(filters: SearchFilters): Promise<SearchResult> {
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const minEntityScore = filters.minEntityScore ?? 0.55;

  const entityKey = filters.entity ? normalizeEntityKey(filters.entity) : null;

  // We compute a similarity score using pg_trgm on entity_key for fuzzy matching.
  const values: unknown[] = [];
  const where: string[] = [];

  const select = entityKey
    ? `SELECT *, similarity(entity_key, $1) AS entity_match_score, COUNT(*) OVER() AS total_count`
    : `SELECT *, NULL::real AS entity_match_score, COUNT(*) OVER() AS total_count`;

  if (entityKey) {
    values.push(entityKey); // $1
    where.push(
      `(entity_key = $${values.length} OR similarity(entity_key, $${values.length}) >= ${minEntityScore.toFixed(2)})`,
    );
  }

  if (filters.agencies && filters.agencies.length > 0) {
    values.push(filters.agencies);
    where.push(`agency = ANY($${values.length})`);
  }

  if (filters.actionTypes && filters.actionTypes.length > 0) {
    values.push(filters.actionTypes);
    where.push(`action_type = ANY($${values.length})`);
  }

  if (filters.statuses && filters.statuses.length > 0) {
    values.push(filters.statuses);
    where.push(`status = ANY($${values.length})`);
  }

  if (typeof filters.minPenalty === "number") {
    values.push(filters.minPenalty);
    where.push(`penalty_amount >= $${values.length}`);
  }
  if (typeof filters.maxPenalty === "number") {
    values.push(filters.maxPenalty);
    where.push(`penalty_amount <= $${values.length}`);
  }

  if (filters.fromDate) {
    values.push(filters.fromDate);
    where.push(`action_date >= $${values.length}::date`);
  }
  if (filters.toDate) {
    values.push(filters.toDate);
    where.push(`action_date <= $${values.length}::date`);
  }

  if (filters.fullText) {
    values.push(filters.fullText);
    where.push(
      `search_vector @@ plainto_tsquery('english', $${values.length})`,
    );
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = entityKey
    ? `ORDER BY entity_match_score DESC NULLS LAST, action_date DESC NULLS LAST`
    : `ORDER BY action_date DESC NULLS LAST`;

  values.push(limit, offset);
  const limitOffset = `LIMIT $${values.length - 1} OFFSET $${values.length}`;

  const sql = `${select} FROM enforcement_actions ${whereClause} ${orderBy} ${limitOffset}`;
  const res = await pool.query<ActionRow>(sql, values);
  const actions = res.rows.map(rowToAction);
  const total = res.rows[0]?.total_count ? Number(res.rows[0].total_count) : 0;

  let entityMatches: SearchResult["entityMatches"] = [];
  if (entityKey) {
    const em = await pool.query<{
      respondent: string;
      entity_key: string;
      best_score: string;
      count: string;
    }>(
      `
      SELECT respondent, entity_key,
             MAX(similarity(entity_key, $1))::text AS best_score,
             COUNT(*)::text AS count
      FROM enforcement_actions
      WHERE similarity(entity_key, $1) >= ${minEntityScore.toFixed(2)}
         OR entity_key = $1
      GROUP BY respondent, entity_key
      ORDER BY best_score DESC, count DESC
      LIMIT 10
      `,
      [entityKey],
    );
    entityMatches = em.rows.map((r) => ({
      respondent: r.respondent,
      entityKey: r.entity_key,
      bestScore: Number(r.best_score),
      count: Number(r.count),
    }));
  }

  return { actions, total, entityMatches };
}

export async function getActionById(actionId: string): Promise<StoredAction | null> {
  const res = await pool.query<ActionRow>(
    `SELECT *, NULL::real AS entity_match_score, COUNT(*) OVER() AS total_count
     FROM enforcement_actions WHERE action_id = $1 LIMIT 1`,
    [actionId],
  );
  const row = res.rows[0];
  return row ? rowToAction(row) : null;
}

export interface AgencyCoverageRow {
  agency: Agency;
  earliestAction: string | null;
  latestAction: string | null;
  totalActions: number;
  lastIngestedAt: string | null;
}

export async function getAgencyCoverage(): Promise<AgencyCoverageRow[]> {
  const res = await pool.query<{
    agency: Agency;
    earliest: Date | null;
    latest: Date | null;
    total: string;
    last_ingested: Date | null;
  }>(
    `
    SELECT a.agency,
           MIN(a.action_date) AS earliest,
           MAX(a.action_date) AS latest,
           COUNT(*)::text     AS total,
           MAX(a.updated_at)  AS last_ingested
    FROM enforcement_actions a
    GROUP BY a.agency
    ORDER BY a.agency
    `,
  );
  return res.rows.map((r) => ({
    agency: r.agency,
    earliestAction: r.earliest ? r.earliest.toISOString().slice(0, 10) : null,
    latestAction: r.latest ? r.latest.toISOString().slice(0, 10) : null,
    totalActions: Number(r.total),
    lastIngestedAt: r.last_ingested ? r.last_ingested.toISOString() : null,
  }));
}

export async function recordIngestionRun(input: {
  agency: Agency;
  status: "success" | "partial" | "error";
  actionsIngested: number;
  actionsUpdated: number;
  errorMessage?: string;
  sourceUrl?: string;
  completedAt?: Date;
}): Promise<void> {
  await pool.query(
    `
    INSERT INTO ingestion_runs (agency, completed_at, status, actions_ingested, actions_updated, error_message, source_url)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      input.agency,
      input.completedAt ?? new Date(),
      input.status,
      input.actionsIngested,
      input.actionsUpdated,
      input.errorMessage ?? null,
      input.sourceUrl ?? null,
    ],
  );
}

export async function getLastIngestionRun(agency: Agency): Promise<{
  status: string;
  completedAt: string | null;
  actionsIngested: number;
  actionsUpdated: number;
  errorMessage: string | null;
} | null> {
  const res = await pool.query<{
    status: string;
    completed_at: Date | null;
    actions_ingested: string;
    actions_updated: string;
    error_message: string | null;
  }>(
    `SELECT status, completed_at, actions_ingested::text, actions_updated::text, error_message
     FROM ingestion_runs
     WHERE agency = $1
     ORDER BY started_at DESC
     LIMIT 1`,
    [agency],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    status: row.status,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    actionsIngested: Number(row.actions_ingested),
    actionsUpdated: Number(row.actions_updated),
    errorMessage: row.error_message,
  };
}
