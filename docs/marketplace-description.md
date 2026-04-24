REGENFORCE delivers cross-agency US financial-regulatory enforcement intelligence. Every enforcement action from the SEC, CFPB, FTC, FINRA, FinCEN, and OCC — normalized into one schema with canonical action types, USD-normalized penalty breakdowns, fuzzy entity resolution, and citation-grade source URLs — in one MCP toolkit for due-diligence analysts, compliance teams, and agent-driven risk workflows. Point it at a company name or person to pull their full enforcement history across all six regulators, run a risk profile with penalty arithmetic, screen peers by topic (AML, KYC, cybersecurity, consumer protection), or list paginated actions by agency and type.

Features

- Cross-agency entity screen: `search_enforcement_by_entity` returns every action across SEC, CFPB, FTC, FINRA, FinCEN, and OCC for a company or person, with an `entityMatches[]` rollup that surfaces name variants (Wise US Inc. / TransferWise Ltd / Wise Payments Limited) and a 0.0–1.0 confidence score per match.
- Risk profile with penalty arithmetic: `get_enforcement_risk_profile` produces a per-entity narrative plus `agencyBreakdown[]`, `timeline[]`, and USD-normalized totals decomposed into civil_penalty, disgorgement, restitution, and prejudgment_interest components.
- Topic / peer screen: `search_enforcement_by_topic` filters the corpus by keywords like "AML KYC" or "cybersecurity" and returns `peerStats.medianPenaltyUsd`, `peerStats.totalPenaltyUsd`, and `peerStats.actionCount` across the chosen agencies.
- Paginated execute primitive: `list_enforcement_actions` returns typed, filterable, paginated per-action records for SDK developers who need a stable schema (by agency, action type, date range, respondent).
- Action detail: `get_enforcement_action` resolves a canonical `AGENCY:id` actionId to the full record with respondents, allegations, penaltyBreakdown, and source PDF.
- Entity resolution: `resolve_entity` returns all name variants for a company or individual with per-variant action count and confidence score.
- Coverage audit: `get_agency_coverage` returns earliest / latest action, total count, last ingestion timestamp, and an explicit `coverageStatus` per agency (`live` | `partial` | `stale` | `unavailable`) plus a human-readable `coverageNote` so callers never silently get stale data.

Currently active coverage

- SEC — 5,054 actions, 2018-01-25 → 2026-04-23 (8 years depth, ingested via Litigation Releases + Administrative Proceedings)
- CFPB — 386 actions, 2012-07-17 → 2025-08-21 (13 years depth, ingested via the CFPB enforcement index)
- FTC — 306 actions, 2022-08-29 → 2026-04-22 (3.7 years depth, ingested via press-release enforcement subset)
- FinCEN — 235 actions, 1999-04-23 → 2026-03-06 (27 years depth, ingested via the FinCEN enforcement HTML table)
- OCC — 326 actions, 2020-04-29 → 2026-04-02 (6 years depth, ingested via the official api.occ.gov JSON API)
- FINRA — 119 actions, 2025-12-17 → 2026-04-21 (~4 months, partial coverage — finra.org rate-limits deep pagination; status is transparently surfaced as `partial` in get_agency_coverage)

Ingestion refreshes every 6 hours; new enforcement actions are queryable within hours of publication.

Try asking

- "Does Wise have any regulatory enforcement history across US financial regulators?"
- "Give me a regulatory risk profile on Robinhood across the SEC, CFPB, and FINRA over the past 5 years."
- "Which banks have been penalized by the OCC or CFPB for AML or KYC failures in the last three years, and what's the typical fine?"
- "List every CFPB consent order since 2022 with respondent, date, and penalty amount."
- "Compare BSA/AML enforcement activity at FinCEN versus the OCC in the past 5 years."
- "What is Wells Fargo's total enforcement penalty footprint across all federal financial regulators in the last 5 years?"
- "Show me every federal financial-regulatory enforcement action against a depository institution in the last 30 days."
- "Disambiguate Bank of America across its subsidiaries — which legal entities have enforcement actions?"

Agent tips

- Start with `search_enforcement_by_entity` for any named company or individual; review `entityMatches[]` + `confidence` before synthesizing so name variants do not get conflated.
- For investor-grade risk memos, prefer `get_enforcement_risk_profile` — it returns a structured narrative plus `agencyBreakdown[]` and a chronological `timeline[]` with `documentUrl` on every action.
- Use `search_enforcement_by_topic` with the `topic` parameter for peer and median-penalty analysis; it computes `peerStats.medianPenaltyUsd` live.
- Use `limit` and `offset` on list endpoints (limit max 200). Check `total` before assuming a single page is exhaustive.
- Call `get_agency_coverage` before reporting a "no actions found" answer — it tells you whether the agency is `live`, `partial`, `stale`, or `unavailable`, and surfaces `coverageNote` for any gap. FINRA is currently `partial` due to source-side WAF rate limits; all other agencies are `live`.
- All methods are `latencyClass: instant` (pre-computed Postgres with pg_trgm + tsvector indexes); safe to fan out in parallel.
- Prefer `structuredContent` when present; it mirrors the JSON payload for schema-aware parsing.
