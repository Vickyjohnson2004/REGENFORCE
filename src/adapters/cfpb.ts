import type {
  NormalizedAction,
  Provenance,
} from "../types.js";
import { classifyActionType } from "../normalization/actionTypes.js";
import { classifyStatus } from "../normalization/status.js";
import { normalizeDate } from "../normalization/dates.js";
import {
  extractPenalty,
  parsePenaltyAmount,
} from "../normalization/penalties.js";
import { normalizeEntityKey } from "../normalization/entities.js";
import {
  fetchJson,
  type AdapterRunResult,
  type AgencyAdapter,
} from "./base.js";

/**
 * CFPB adapter: pulls from the CFPB enforcement-actions dataset on
 * data.consumerfinance.gov (Socrata).
 *
 * Dataset: "Enforcement Actions"
 *   https://data.consumerfinance.gov/resource/y6mt-r5kq.json
 *
 * The CFPB also publishes actions as an HTML + CSV list at
 *   https://www.consumerfinance.gov/enforcement/actions/
 * but the Socrata resource is the stable, structured API.
 */

const SOCRATA_URL =
  "https://data.consumerfinance.gov/resource/sjn8-e27p.json?$limit=500&$order=final_disposition_date%20DESC";

interface CfpbRow {
  case_id?: string;
  name?: string;
  respondent?: string;
  respondents?: string;
  docket_number?: string;
  institution?: string;
  court?: string;
  status?: string;
  final_disposition?: string;
  action?: string;
  action_type?: string;
  product?: string;
  court_name?: string;
  final_disposition_date?: string;
  date?: string;
  civil_money_penalty_amount?: string;
  consumer_redress_amount?: string;
  disgorgement_amount?: string;
  total_monetary_relief?: string;
  summary?: string;
  document_url?: string;
  url?: string;
  press_release_url?: string;
}

export class CFPBAdapter implements AgencyAdapter {
  readonly agency = "CFPB" as const;

  async fetchRecent(): Promise<AdapterRunResult> {
    const errors: AdapterRunResult["errors"] = [];
    let rows: CfpbRow[] = [];
    try {
      rows = await fetchJson<CfpbRow[]>(SOCRATA_URL, { timeoutMs: 20_000 });
    } catch (err) {
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        hint:
          `CFPB Socrata endpoint (${SOCRATA_URL}) failed. If the dataset was renamed, update SOCRATA_URL. Public mirror: https://www.consumerfinance.gov/enforcement/actions/`,
      });
      return { agency: "CFPB", sourceUrl: SOCRATA_URL, actions: [], errors };
    }

    if (!Array.isArray(rows)) {
      errors.push({ message: "CFPB Socrata returned non-array payload", hint: SOCRATA_URL });
      return { agency: "CFPB", sourceUrl: SOCRATA_URL, actions: [], errors };
    }

    const actions: NormalizedAction[] = [];
    for (const row of rows) {
      const built = this.normalizeRow(row);
      if (built) actions.push(built);
    }
    return { agency: "CFPB", sourceUrl: SOCRATA_URL, actions, errors };
  }

  private normalizeRow(row: CfpbRow): NormalizedAction | null {
    const respondent = row.respondent ?? row.name ?? row.institution ?? undefined;
    if (!respondent) return null;

    const id =
      row.case_id ??
      row.docket_number ??
      `${respondent}|${row.final_disposition_date ?? row.date ?? ""}`;
    const actionId = `CFPB:${sanitizeId(id)}`;

    const date = normalizeDate(row.final_disposition_date ?? row.date);
    const rawActionType =
      row.action_type ?? row.action ?? row.final_disposition ?? undefined;
    const actionType = classifyActionType("CFPB", rawActionType, [
      respondent,
      row.summary ?? "",
    ]);
    const status = classifyStatus([row.status ?? "", row.final_disposition ?? ""]);

    const cmp = parsePenaltyAmount(row.civil_money_penalty_amount);
    const redress = parsePenaltyAmount(row.consumer_redress_amount);
    const disgorge = parsePenaltyAmount(row.disgorgement_amount);
    const total = parsePenaltyAmount(row.total_monetary_relief);

    const breakdown: NormalizedAction["penaltyBreakdown"] = [];
    if (cmp) breakdown.push({ amount: cmp, currency: "USD", type: "civil_penalty" });
    if (redress) breakdown.push({ amount: redress, currency: "USD", type: "restitution" });
    if (disgorge) breakdown.push({ amount: disgorge, currency: "USD", type: "disgorgement" });

    let amount: number | undefined;
    let penaltyOrigin: "observed" | "inferred" | "unknown" = "unknown";
    if (breakdown.length > 0) {
      amount = breakdown.reduce((acc, c) => acc + c.amount, 0);
      penaltyOrigin = "observed";
    } else if (total) {
      amount = total;
      penaltyOrigin = "observed";
    } else if (row.summary) {
      const extracted = extractPenalty(row.summary);
      amount = extracted.amount;
      penaltyOrigin = extracted.origin;
      if (extracted.breakdown) breakdown.push(...extracted.breakdown);
    }

    const documentUrl =
      row.document_url ?? row.press_release_url ?? row.url ?? undefined;

    const provenance: Provenance = {
      source: "CFPB-Socrata-sjn8-e27p",
      sourceUrl: SOCRATA_URL,
      fetchedAt: new Date().toISOString(),
      fieldOrigin: {
        agency: "observed",
        actionId: "observed",
        actionType: "normalized",
        rawActionType: "observed",
        status: "normalized",
        respondent: "observed",
        actionDate: "normalized",
        penaltyAmount: penaltyOrigin,
        penaltyBreakdown: penaltyOrigin,
        allegations: row.summary ? "observed" : "unknown",
        documentUrl: documentUrl ? "observed" : "unknown",
      },
    };

    return {
      actionId,
      agency: "CFPB",
      actionType,
      rawActionType,
      status,
      rawStatus: row.status,
      actionDate: date,
      respondent,
      respondents: [respondent],
      penaltyAmount: amount,
      penaltyCurrency: "USD",
      penaltyBreakdown: breakdown.length > 0 ? breakdown : undefined,
      allegations: row.summary ?? row.product,
      title: row.name ?? respondent,
      summary: row.summary,
      documentUrl,
      entityKey: normalizeEntityKey(respondent),
      provenance,
      rawPayload: row,
    };
  }
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}
