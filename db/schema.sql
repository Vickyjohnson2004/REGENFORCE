-- ============================================================================
-- REGENFORCE schema
--
-- Stores normalized cross-agency financial regulatory enforcement actions from
-- SEC, CFPB, FTC, FINRA, FinCEN and OCC. All normalization is computed at
-- ingestion time; MCP queries are pure reads with full-text search.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS enforcement_actions (
    id                  BIGSERIAL PRIMARY KEY,

    -- Stable deterministic identifier composed of `${agency}:${agencyId}`.
    action_id           TEXT NOT NULL UNIQUE,

    agency              TEXT NOT NULL CHECK (agency IN ('SEC','CFPB','FTC','FINRA','FINCEN','OCC')),

    -- Canonical taxonomy: consent_order, civil_penalty, cease_and_desist,
    -- suspension, bar, expulsion, formal_agreement, litigation, other.
    action_type         TEXT NOT NULL,
    raw_action_type     TEXT,

    -- Canonical status: filed, settled, pending, final_order, dismissed, unknown.
    status              TEXT NOT NULL DEFAULT 'unknown',
    raw_status          TEXT,

    action_date         DATE,
    respondent          TEXT NOT NULL,
    respondents         JSONB NOT NULL DEFAULT '[]'::JSONB,

    -- Normalized penalty fields. All penalties stored in USD.
    penalty_amount      NUMERIC(18,2),
    penalty_currency    TEXT DEFAULT 'USD',
    penalty_breakdown   JSONB,

    allegations         TEXT,
    title               TEXT,
    summary             TEXT,
    document_url        TEXT,

    -- Fuzzy-match key: lowercased, stripped of corporate suffixes and punctuation.
    entity_key          TEXT NOT NULL,

    -- Full provenance: {fieldOrigin, source, fetchedAt, sourceUpdatedAt, ...}
    provenance          JSONB NOT NULL,

    -- Raw upstream payload, kept for schema drift debugging.
    raw_payload         JSONB,

    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    search_vector       TSVECTOR
);

CREATE INDEX IF NOT EXISTS idx_actions_agency        ON enforcement_actions (agency);
CREATE INDEX IF NOT EXISTS idx_actions_date          ON enforcement_actions (action_date DESC);
CREATE INDEX IF NOT EXISTS idx_actions_type          ON enforcement_actions (action_type);
CREATE INDEX IF NOT EXISTS idx_actions_status        ON enforcement_actions (status);
CREATE INDEX IF NOT EXISTS idx_actions_entity_key    ON enforcement_actions (entity_key);
CREATE INDEX IF NOT EXISTS idx_actions_penalty       ON enforcement_actions (penalty_amount);
CREATE INDEX IF NOT EXISTS idx_actions_respondent_trgm
    ON enforcement_actions USING gin (respondent gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_actions_entity_trgm
    ON enforcement_actions USING gin (entity_key gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_actions_search
    ON enforcement_actions USING gin (search_vector);

CREATE OR REPLACE FUNCTION enforcement_actions_search_vector_update()
RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', coalesce(NEW.respondent, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.title, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(NEW.allegations, '')), 'C') ||
        setweight(to_tsvector('english', coalesce(NEW.summary, '')), 'C') ||
        setweight(to_tsvector('simple',  coalesce(NEW.action_id, '')), 'D') ||
        setweight(to_tsvector('simple',  coalesce(NEW.agency, '')), 'D');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforcement_actions_search_vector ON enforcement_actions;
CREATE TRIGGER trg_enforcement_actions_search_vector
    BEFORE INSERT OR UPDATE ON enforcement_actions
    FOR EACH ROW EXECUTE FUNCTION enforcement_actions_search_vector_update();

-- ============================================================================
-- Ingestion state: tracks last successful run per source.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ingestion_runs (
    id                  BIGSERIAL PRIMARY KEY,
    agency              TEXT NOT NULL,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','partial','error')),
    actions_ingested    INTEGER NOT NULL DEFAULT 0,
    actions_updated     INTEGER NOT NULL DEFAULT 0,
    error_message       TEXT,
    source_url          TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_agency_started
    ON ingestion_runs (agency, started_at DESC);
