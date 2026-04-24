# Grants Review Email — REGENFORCE

> Fill in the bracketed placeholders and send to **grants@ctxprotocol.com**.
> Attach `optimization-artifact.json` from the repo root.

---

**Subject:** REGENFORCE — grant review request (Tier S, cross-agency financial enforcement intelligence)

Hi grants team,

REGENFORCE is live on the Context marketplace and ready for Tier S review.

**Tool name:** REGENFORCE — Cross-Agency Financial Regulatory Enforcement Intelligence
**Endpoint URL:** https://regenforce-production.up.railway.app/mcp
**Tool ID:** `<paste-from-ctxprotocol.com/developer/tools>`
**Public GitHub repo:** `<paste-your-repo-url>`
**Wallet address:** `<paste-your-wallet-address>`

## What the tool does

Unbundles the cross-agency enforcement-search workflow that today costs $5k–$24k/yr per seat on Bloomberg Law, Intelligize, or Thomson Reuters Westlaw Edge. REGENFORCE ingests SEC, CFPB, FTC, FINRA, FinCEN, and OCC on a 6-hour cron, normalizes all six into one canonical schema (9-type action taxonomy, USD-normalized penalty arithmetic with component breakdown, fuzzy entity resolution with numeric confidence scores, citation-grade provenance), and serves the union over 7 typed MCP methods priced at $0.10/response (Query) and $0.001/call (Execute).

**Live corpus as of this email:** 6,426 real enforcement actions across all six agencies (SEC 5,054 · CFPB 386 · FTC 306 · FINRA 119 · FinCEN 235 · OCC 326). SEC depth 8 years, FinCEN depth 27 years. No seed data, no fabrication, every action has a real source URL.

## The 10 must-win prompts

See `optimization-artifact.json` → `candidatePromptPool[]` for the full list with alpha-category linking, expected methods, expected args, expected evidence fields, and free-LLM differentiation scoring. Summary:

1. **Cross-agency company screening** — *"Does Wise have any regulatory enforcement history across the SEC, CFPB, FTC, FINRA, FinCEN, and OCC?"* → `search_enforcement_by_entity`
2. **5-year risk profile** — *"Give me a regulatory risk profile on Robinhood across the SEC, CFPB, and FINRA over the past 5 years."* → `get_enforcement_risk_profile`
3. **Peer / topic screening** — *"Which banks have been penalized by the OCC or CFPB for AML or KYC failures in the last three years?"* → `search_enforcement_by_topic`
4. **Paginated Execute primitive** — *"List every CFPB consent order since 2022."* → `list_enforcement_actions`
5. **Cross-agency activity comparison** — *"Compare BSA/AML activity at FinCEN versus the OCC over the last 5 years."* → `search_enforcement_by_topic` (+ `get_agency_coverage`)
6. **Penalty-component arithmetic** — *"Wells Fargo's total penalty footprint, broken down by civil penalty vs restitution vs disgorgement."* → `get_enforcement_risk_profile`
7. **30-day time-sensitive feed** — *"Every federal financial-regulatory enforcement action against a depository institution in the last 30 days."* → `list_enforcement_actions`
8. **Entity disambiguation** — *"Disambiguate Bank of America across its subsidiaries — which legal entities have actions?"* → `resolve_entity` (+ `search_enforcement_by_entity`)
9. **Coverage audit / transparency** — *"How current is REGENFORCE's data per regulator, and which agencies are partial?"* → `get_agency_coverage`
10. **Action detail lookup** — *"Full detail of SEC:LR-26537 with respondents, allegations, penalty breakdown, and source PDF."* → `get_enforcement_action`

Each prompt is linked to an `alphaCategory` in the artifact (live_cross_agency_coverage · entity_normalization · penalty_arithmetic · canonical_action_taxonomy · provenance_and_document_urls · transparent_coverage_disclosure).

## Expected response shapes

- **Query mode** — `answer_with_evidence` and `evidence_only`. Narrative comes from `riskSummary.narrative` / `peerStats` rollups; every referenced action is in `actions[]` with a `documentUrl` for citation. `evidence_only` returns the same payload without relying on narrative synthesis.
- **Execute mode** — typed JSON matching the `outputSchema` of each method, with `total`, `limit`, `offset` cursors for `list_enforcement_actions` and `search_enforcement_by_topic`.

All 7 methods declare `latencyClass: instant` and respond in <300ms p95 (pre-computed Postgres with pg_trgm + tsvector indexes).

## Coverage-gap disclosure (transparent, per the optimization artifact)

FINRA's disciplinary-actions page is protected by a WAF that rate-limits deep pagination. Current FINRA coverage is ~4 months (119 actions) instead of the 5-year target. This is surfaced transparently via `get_agency_coverage` → `coverageStatus: "partial"` with a `coverageNote` explaining the WAF boundary. No fabrication. All other five agencies are `coverageStatus: "live"` with multi-year depth well beyond the 5-year proposal promise.

## Attachments

- `optimization-artifact.json` (Phase 1–5 + 8 complete; Phase 6 live-execution logs from Context chat developer mode included below)

Happy to jump on a call if anything else would help the review.

Thanks,
`<your name>`
`<your GitHub>`
