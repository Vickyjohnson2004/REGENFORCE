# REGENFORCE

**Cross-Agency Financial Regulatory Enforcement Intelligence** — a Context Protocol MCP server that unifies enforcement actions from **six US federal financial regulators** (SEC, CFPB, FTC, FINRA, FinCEN, OCC) behind a single normalized schema.

Replaces the enforcement-monitoring layer that justifies Bloomberg Law ($5,000+/year), Intelligize ($10,000+/year), and Thomson Reuters Regulatory Intelligence, plus the fragile manual RSS / spreadsheet workflows compliance teams use today.

- **Query mode** (Context app): `$0.10` per response — curated enforcement intelligence with entity resolution, risk summaries, and narrative memos.
- **Execute mode** (SDK): `$0.001` per call — normalized typed enforcement records agents can iterate over.

## 1. Product Contract

| | |
|---|---|
| Target buyer | AML/BSA compliance officers (banks + fintechs), fintech regulatory lawyers, VC/PE/M&A due-diligence teams, compliance consultants, bank examiners |
| Premium feature | Unified cross-agency enforcement history for any company or individual in a single call |
| Painful substitute | 6 agency websites + 10+ RSS feeds + 20+ spreadsheet tabs (per r/AMLCompliance) |
| Paid substitute | Bloomberg Law ($5k+/yr), Intelligize ($10k+/yr), Thomson Reuters RI ($8k+/yr) |
| Freshness target | Sub-3s cached, sub-10s uncached; source ingested every 6h by default |
| Latency target | Under 60s (hard Context requirement); typically <500ms |

### Must-win prompts

See [`docs/must-win-prompts.md`](docs/must-win-prompts.md).

1. *"Does Wise have any regulatory enforcement history across US financial regulators?"*
2. *"Give me a regulatory risk profile on Robinhood across the SEC, CFPB, and FINRA."*
3. *"Which banks have been penalized by the OCC or CFPB for AML/KYC failures in the last three years?"*
4. *"List every CFPB consent order against payments companies since 2022."*
5. *"Compare BSA/AML enforcement activity at FinCEN vs the OCC in the past 5 years."*

### Evidence fields

Every enforcement-action record includes:

- `actionId`, `agency`, `actionType` (canonical), `rawActionType` (source phrasing)
- `status` (canonical), `rawStatus`
- `actionDate` (ISO 8601), `respondent`, `respondents[]`
- `penaltyAmount` (USD), `penaltyBreakdown[]` (civil_penalty / disgorgement / restitution / prejudgment_interest)
- `title`, `summary`, `allegations`
- `documentUrl` (link back to source), `entityMatchConfidence` (high/medium/low), `entityMatchScore`
- `provenance` = `{ source, fetchedAt, fieldOrigin }`  — every field tagged as `observed` / `normalized` / `inferred` / `unknown`

## 2. Architecture

```
 ┌───────────────────────────────────────────────────────────┐
 │ Agency Adapters (SEC, CFPB, FTC, FINRA, FinCEN, OCC)      │
 │ RSS + Atom + Socrata + Data.gov + HTML scraping (Cheerio) │
 └──────────────────────────┬────────────────────────────────┘
                            │ NormalizedAction[]
            ┌───────────────▼─────────────────┐
            │ Normalization engine            │
            │ • action-type taxonomy          │
            │ • entity resolution (fuzzy)     │
            │ • penalty parsing / USD         │
            │ • date + status canonicalize    │
            │ • field-provenance tagging      │
            └───────────────┬─────────────────┘
                            │ upsertAction()
            ┌───────────────▼─────────────────┐
            │ PostgreSQL (pg_trgm)            │
            │ + generated tsvector            │
            │ + agency/entity/date indexes    │
            └───────────────┬─────────────────┘
                            │
            ┌───────────────▼─────────────────┐
            │ Redis (15-min TTL) – optional   │
            └───────────────┬─────────────────┘
                            │
            ┌───────────────▼─────────────────┐
            │ MCP tools (Query + Execute)     │
            │ Express / StreamableHTTP / JWT  │
            └─────────────────────────────────┘
```

### Stack

- **Node 20 + TypeScript 5** (strict).
- **Express 4** for the HTTP surface + `/mcp` / `/health` / `/admin/ingest`.
- `@modelcontextprotocol/sdk` (server + StreamableHTTP transport).
- `@ctxprotocol/sdk` (`createContextMiddleware` for JWT verification).
- **PostgreSQL 14+** with `pg_trgm` extension for trigram similarity + full-text search.
- **Redis** (optional — falls back to an in-memory LRU).
- `node-cron` for scheduled ingestion.
- `cheerio` + `fast-xml-parser` + Socrata / Data.gov REST.
- `pino` for structured logging.

## 3. MCP Tools

### Query mode (billable per response)

| Tool | Purpose |
|------|---------|
| `search_enforcement_by_entity` | Full cross-agency enforcement history for a company / individual, with risk summary + entity-match confidence. |
| `get_enforcement_risk_profile` | Standalone regulatory-risk profile: total penalty exposure, agency breadth, time-series timeline, plain-English narrative. |
| `search_enforcement_by_topic` | Enforcement actions matching a topic / violation keyword (e.g. "AML KYC", "mortgage servicing"), plus peer-enforcement stats. |

### Execute mode (billable per call, $0.001)

| Method | Purpose |
|--------|---------|
| `list_enforcement_actions` | Paginated, filterable typed primitive — agency, entity, dates, action-type, status, free-text. |
| `get_enforcement_action` | Fetch one canonical action by `actionId`. |
| `resolve_entity` | Fuzzy-match an entity string, return canonical respondents with confidence buckets. |
| `get_agency_coverage` | Return coverage metadata (earliest / latest action, counts, last ingestion) per agency. |

All tools return:

- `outputSchema`-validated `structuredContent`,
- freshness metadata (`generatedAt`, `sourceUpdatedAt`, `dataFreshness`),
- per-response `entityMatchConfidence` so agents know when a match is fuzzy.

## 4. Local development

### Prerequisites

- Node 20+
- PostgreSQL 14+ (a fresh DB is fine; migrations add the `pg_trgm` extension)
- Redis (optional)

### Setup

```bash
cp .env.example .env
# then edit DATABASE_URL / REDIS_URL / DATA_GOV_API_KEY
npm install
npm run db:migrate
npm run ingest all     # one-shot ingestion from all six agencies
npm run dev            # starts the MCP server on PORT (default 4010)
```

### Sanity-check the MCP surface

```bash
curl -s http://localhost:4010/health | jq
curl -s -X POST http://localhost:4010/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

`tools/list` is unauthenticated (MCP discovery). `tools/call` requires a Context JWT when `CONTEXT_AUTH_ENABLED=true`.

### Environment variables

See [`.env.example`](.env.example). Key ones:

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `4010` | |
| `CONTEXT_AUTH_ENABLED` | `false` locally, **must be `true` in production** (paid tool) |
| `DATABASE_URL` | required | Any Postgres connection string. Railway's managed Postgres works out of the box. |
| `DATABASE_SSL_STRICT` | `false` | Set to `true` if your provider mandates cert verification. |
| `REDIS_URL` | — | Optional. In-memory LRU is used when empty. |
| `REDIS_TTL_SECONDS` | `900` | 15-min hot cache. |
| `INGEST_ON_STARTUP` | `false` | Set to `true` for first-boot bootstrapping. |
| `INGEST_CRON` | `7 */6 * * *` | Every 6 hours. |
| `INGEST_DISABLE` | — | CSV list of agency codes to skip (e.g. `FTC` if you lack a Data.gov key). |
| `DATA_GOV_API_KEY` | — | Required for the FTC API. Without it, the adapter falls back to the FTC press-release RSS feed. |
| `ADMIN_INGEST_TOKEN` | — | Shared secret for `POST /admin/ingest`. Empty disables the endpoint. |
| `LOG_LEVEL` | `info` | |

## 5. Deployment to Railway

1. Create a Railway project and add **PostgreSQL** (and optionally **Redis**) services.
2. Link this repo; Railway auto-detects the `Dockerfile` (or falls back to Nixpacks using `railway.json`).
3. In the service environment, set at minimum:
   - `CONTEXT_AUTH_ENABLED=true`
   - `INGEST_ON_STARTUP=true` (for the first deployment only — toggle off afterwards)
   - `DATA_GOV_API_KEY` (free, instant from [api.data.gov](https://api.data.gov/signup/))
   - `ADMIN_INGEST_TOKEN` (random 32+ char string)
4. Deploy. The `start` command runs `db:migrate && server`, so the schema is idempotently applied on every boot.
5. Grab the Railway public URL → your MCP endpoint is `https://<railway-url>/mcp`.
6. Register on [ctxprotocol.com/contribute](https://ctxprotocol.com/contribute) with the endpoint, stake USDC, then follow Step 5–6 of the grants doc (optimization skill + review email to `grants@ctxprotocol.com`).

See [`docs/deployment.md`](docs/deployment.md) for the full runbook.

## 6. Ingestion pipeline

```
npm run ingest all         # all six agencies
npm run ingest SEC         # a single agency
```

Scheduled ingestion is driven by `INGEST_CRON` (default: every 6 hours at minute 7). Each run:

1. Fetches source bytes (RSS / Atom / JSON / HTML) with a short timeout.
2. Normalizes every action via the shared engine.
3. Upserts by `action_id`; only the changed rows are written (`ON CONFLICT DO UPDATE WHERE`).
4. Writes a row to `ingestion_runs` (duration, actions-new, actions-updated, status).

Manual trigger (for when a source redesigns its page and you need to re-pull):

```bash
curl -X POST "$URL/admin/ingest" \
  -H "x-admin-token: $ADMIN_INGEST_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"agency":"FINRA"}'
```

### HTML parsing notes (FINRA + OCC + FinCEN)

Per the approval feedback, these three adapters are the highest-risk because they are pure HTML scrapers. Each adapter documents its selectors inline with comments starting `// SELECTOR:` and degrades gracefully:

- Missing fields are tagged `fieldOrigin: "unknown"` rather than crashing.
- Each run records `actionsNew`, `actionsUpdated`, and `errors[]`; a zero-result run logs a WARN so operators can alert on page redesigns.
- The `/admin/ingest` endpoint lets you re-run a single agency after a selector patch without waiting for cron.

## 7. Entity resolution

Entity matching uses a blend of:

- **Postgres `pg_trgm` similarity** on the `entity_key` column (a punctuation-stripped, suffix-stripped normal form of the respondent name).
- **Jaccard token similarity** layered with **Levenshtein distance** on top candidates.
- Optional exact-key early-out for high-confidence matches.

Confidence buckets (exposed on every response):

| Score | Bucket |
|-------|--------|
| ≥ 0.9 | `high` (near-exact) |
| ≥ 0.7 | `medium` (likely same entity, minor name variation) |
| < 0.7 | `low` (fuzzy — display but flag) |

## 8. Project layout

```
src/
├── adapters/           # one module per agency
│   ├── sec.ts
│   ├── cfpb.ts
│   ├── ftc.ts
│   ├── finra.ts
│   ├── fincen.ts
│   └── occ.ts
├── cache/redis.ts      # Redis or in-memory backend
├── config.ts
├── db/
│   ├── client.ts
│   ├── migrate.ts
│   └── repository.ts
├── ingest/
│   ├── runner.ts
│   ├── scheduler.ts
│   └── cli.ts
├── mcp/
│   ├── tools.ts        # inputSchema + outputSchema + _meta for every tool
│   └── handlers.ts     # business logic + dispatchTool()
├── normalization/
│   ├── actionTypes.ts
│   ├── dates.ts
│   ├── entities.ts
│   ├── penalties.ts
│   └── status.ts
├── logger.ts
├── types.ts
└── server.ts           # Express + MCP transport + /health + /admin
db/schema.sql
```

## 9. Error handling contract

Every tool returns one of:

- `{ ok: true, data: <structuredContent> }` → wrapped in `{ content: [text], structuredContent: data }`.
- `{ ok: false, error: { code, message, field? } }` → wrapped with `isError: true`.

Codes: `INVALID_INPUT`, `NOT_FOUND`, `UPSTREAM_UNAVAILABLE`, `INTERNAL`. No crashes — every adapter failure is caught and logged.

## 10. License

MIT — see `LICENSE`.
