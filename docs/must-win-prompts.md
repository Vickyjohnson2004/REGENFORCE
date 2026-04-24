# Must-Win Prompts

These are the five prompts REGENFORCE is engineered to answer with evidence that a free LLM cannot produce. Each prompt has an expected tool call, expected evidence fields, and the specific failure mode it guards against.

> All five are exercised end-to-end during Context optimization (`mcp-tool-optimization-skill`). Pass rate must be ≥ 85% before grant review.

---

## 1. Cross-agency company screening

**Prompt:** *"Does Wise have any regulatory enforcement history across US financial regulators? Include SEC, CFPB, FTC, FINRA, FinCEN, and OCC."*

**Expected tool:** `search_enforcement_by_entity`

**Arguments:**
```json
{ "entity": "Wise", "agencies": ["SEC","CFPB","FTC","FINRA","FinCEN","OCC"], "minConfidence": "medium" }
```

**Evidence fields the buyer must see:**
- `entity`, `entityMatches[].respondent`, `entityMatches[].confidence`
- `riskSummary.totalActions`, `riskSummary.totalPenaltyUsd`, `riskSummary.agenciesInvolved`
- One or more `actions[]` rows with `agency`, `actionType`, `actionDate`, `penaltyAmount`, `documentUrl`, `provenance.fieldOrigin`
- `metadata.dataFreshness`, `metadata.sourceUpdatedAt`

**Why a free LLM fails:** ChatGPT cannot pull six live agency feeds and reconcile "TransferWise Ltd" / "Wise US Inc." / "Wise Payments Limited" to a single entity with citation-quality URLs.

---

## 2. Pre-investment risk profile

**Prompt:** *"Give me a regulatory risk profile on Robinhood across the SEC, CFPB, and FINRA over the past 5 years. I'm about to due-diligence them."*

**Expected tool:** `get_enforcement_risk_profile`

**Arguments:**
```json
{ "entity": "Robinhood", "lookbackYears": 5 }
```

**Evidence fields:**
- `resolvedRespondent`, `matchConfidence`
- `riskSummary.narrative` (plain-English memo)
- `agencyBreakdown[]` — per-agency action count and total penalty
- `timeline[]` — chronological actions with canonical `actionType` (`civil_penalty`, `consent_order`, …)
- `entityMatches[]`

**Why a free LLM fails:** No live penalty arithmetic, no audited timeline, no entity-match confidence.

---

## 3. Peer-enforcement / topic screen

**Prompt:** *"Which banks have been penalized by the OCC or CFPB for AML or KYC failures in the last three years, and what's the typical fine?"*

**Expected tool:** `search_enforcement_by_topic`

**Arguments:**
```json
{ "topic": "AML KYC", "agencies": ["OCC","CFPB"], "fromDate": "2023-01-01" }
```

**Evidence fields:**
- `topic` echoed back
- `actions[]` with `respondent`, `agency`, `actionType`, `penaltyAmount`, `documentUrl`
- `peerStats.actionCount`, `peerStats.totalPenaltyUsd`, `peerStats.medianPenaltyUsd`, `peerStats.agenciesInvolved`

**Why a free LLM fails:** Requires aggregating hundreds of actions across two agencies and computing median penalty — hallucination-prone at best.

---

## 4. Execute primitive — pagination

**Prompt (SDK execute):** *list every CFPB consent order since 2022.*

**Expected tool:** `list_enforcement_actions`

**Arguments:**
```json
{ "agencies": ["CFPB"], "actionTypes": ["consent_order"], "fromDate": "2022-01-01", "limit": 100 }
```

**Evidence fields:**
- `actions[]` with canonical fields
- `total` (result count)
- `limit`, `offset` pagination cursors
- `metadata.dataFreshness`

**Why developers pay:** Typed, paginated, normalized primitive with stable schema — no HTML scraping.

---

## 5. Cross-agency activity comparison

**Prompt:** *"Compare BSA/AML enforcement activity at FinCEN versus the OCC in the past 5 years."*

**Expected tools:** `search_enforcement_by_topic` (twice) or `list_enforcement_actions` + `get_agency_coverage`

**Arguments (primary):**
```json
{ "topic": "BSA AML", "agencies": ["FinCEN","OCC"], "fromDate": "2020-01-01" }
```

**Evidence fields:**
- `peerStats.agenciesInvolved` (FinCEN + OCC)
- Per-agency action counts from the `actions[]` rollup
- Penalty totals, median penalty
- `metadata.agencyCoverage` (so the buyer knows both agencies are fully ingested, not just one)

**Why a free LLM fails:** Requires a normalized corpus across two agencies that publish in completely different formats (FinCEN HTML + RSS via GovInfo vs OCC searchable HTML).

---

## Response shapes

| Shape | Where used |
|-------|-----------|
| `answer_with_evidence` | Context chat (default) — `riskSummary.narrative` is the prose; every `actions[]` item is evidence with `documentUrl`. |
| `evidence_only` | External agents — same payload without relying on narrative synthesis; every structured field is self-explanatory (canonical enums + descriptions in the outputSchema). |
| Execute JSON | SDK `client.tools.execute({...})` — typed primitive with `total`, `limit`, `offset`, and `actions[]`. |
