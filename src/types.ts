export const AGENCIES = ["SEC", "CFPB", "FTC", "FINRA", "FINCEN", "OCC"] as const;
export type Agency = (typeof AGENCIES)[number];

export const CANONICAL_ACTION_TYPES = [
  "consent_order",
  "civil_penalty",
  "cease_and_desist",
  "suspension",
  "bar",
  "expulsion",
  "formal_agreement",
  "litigation",
  "administrative_proceeding",
  "other",
] as const;
export type ActionType = (typeof CANONICAL_ACTION_TYPES)[number];

export const CANONICAL_STATUSES = [
  "filed",
  "settled",
  "pending",
  "final_order",
  "dismissed",
  "unknown",
] as const;
export type ActionStatus = (typeof CANONICAL_STATUSES)[number];

export type FieldOrigin = "observed" | "normalized" | "inferred" | "unknown";

export interface FieldProvenance {
  /** Per-field origin tags. Keys are field names on the public schema. */
  [fieldName: string]: FieldOrigin;
}

export interface Provenance {
  source: string;
  sourceUrl?: string;
  fetchedAt: string;
  sourceUpdatedAt?: string;
  fieldOrigin: FieldProvenance;
}

export interface PenaltyComponent {
  amount: number;
  currency: string;
  type: "civil_penalty" | "disgorgement" | "restitution" | "prejudgment_interest" | "other";
}

export interface NormalizedAction {
  /** Stable id, `${agency}:${agencyId}`. */
  actionId: string;
  agency: Agency;
  actionType: ActionType;
  rawActionType?: string;
  status: ActionStatus;
  rawStatus?: string;

  /** ISO 8601 date (YYYY-MM-DD). */
  actionDate?: string;
  respondent: string;
  respondents: string[];

  /** Total penalty amount in USD. Null when not disclosed / not applicable. */
  penaltyAmount?: number;
  penaltyCurrency: "USD";
  penaltyBreakdown?: PenaltyComponent[];

  allegations?: string;
  title?: string;
  summary?: string;
  documentUrl?: string;

  /** Normalized fuzzy-match key. */
  entityKey: string;

  provenance: Provenance;

  /** Original raw source payload. Not returned to MCP clients by default. */
  rawPayload?: unknown;
}

export interface EntityMatch {
  entityKey: string;
  canonicalName: string;
  confidence: "high" | "medium" | "low";
  score: number;
  matchedFrom: "exact" | "alias" | "fuzzy";
}
