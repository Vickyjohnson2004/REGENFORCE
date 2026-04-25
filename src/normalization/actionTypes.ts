import type { ActionType, Agency } from "../types.js";

/**
 * Maps agency-specific action type vocabulary into canonical REGENFORCE taxonomy.
 *
 * The canonical taxonomy (see CANONICAL_ACTION_TYPES in types.ts):
 *   consent_order, civil_penalty, cease_and_desist, suspension, bar,
 *   expulsion, formal_agreement, litigation, administrative_proceeding, other
 *
 * Source-specific phrasing is preserved in `rawActionType`. This mapping is
 * intentionally conservative: when no confident match exists the classifier
 * returns `other` so downstream consumers can filter rather than guess.
 */

type Rule = { pattern: RegExp; canonical: ActionType };

const SHARED_RULES: Rule[] = [
  { pattern: /\bconsent\s+order\b/i, canonical: "consent_order" },
  { pattern: /\bcease[-\s]?and[-\s]?desist\b/i, canonical: "cease_and_desist" },
  { pattern: /\bc\s*&\s*d\b/i, canonical: "cease_and_desist" },
  { pattern: /\bformal\s+agreement\b/i, canonical: "formal_agreement" },
  { pattern: /\bprompt\s+corrective\s+action\b/i, canonical: "formal_agreement" },
  { pattern: /\bexpulsion|expelled\b/i, canonical: "expulsion" },
  { pattern: /\bbarred|\bbar\b|\bpermanent\s+bar\b/i, canonical: "bar" },
  { pattern: /\bsuspension|suspend(ed)?\b/i, canonical: "suspension" },
  { pattern: /\bcivil\s+(money\s+)?penalty\b/i, canonical: "civil_penalty" },
  { pattern: /\bmonetary\s+penalty\b/i, canonical: "civil_penalty" },
  { pattern: /\bfine(d)?\b/i, canonical: "civil_penalty" },
  { pattern: /\blitigation\s+release\b/i, canonical: "litigation" },
  { pattern: /\bcomplaint\b/i, canonical: "litigation" },
  { pattern: /\blawsuit\b/i, canonical: "litigation" },
  { pattern: /\bindictment\b/i, canonical: "litigation" },
  { pattern: /\bdisciplinary\s+action\b/i, canonical: "administrative_proceeding" },
  { pattern: /\badministrative\s+(proceeding|action)\b/i, canonical: "administrative_proceeding" },
];

const AGENCY_RULES: Record<Agency, Rule[]> = {
  SEC: [
    // SEC adapter populates rawActionType from a sourceKey identifier such as
    // `litigation_release` or `administrative_proceeding` — match those first
    // so they don't fall through to the SHARED_RULES whitespace pattern.
    { pattern: /\blitigation[_\s]release\b/i, canonical: "litigation" },
    { pattern: /\badministrative[_\s]proceeding\b/i, canonical: "administrative_proceeding" },
    { pattern: /^LR-/, canonical: "litigation" },
    { pattern: /\bLR-\d/i, canonical: "litigation" },
    { pattern: /34-/, canonical: "administrative_proceeding" },
    { pattern: /IA-/, canonical: "administrative_proceeding" },
    { pattern: /IC-/, canonical: "administrative_proceeding" },
  ],
  CFPB: [
    { pattern: /\bstipulation\b/i, canonical: "consent_order" },
    { pattern: /\bproposed\s+(order|final\s+order)\b/i, canonical: "consent_order" },
    { pattern: /\b(default\s+)?judgment\b/i, canonical: "consent_order" },
    { pattern: /\bpost[-\s]?judgment\b/i, canonical: "consent_order" },
    { pattern: /\bsettled\b/i, canonical: "consent_order" },
    { pattern: /\bfinal\s+order\b/i, canonical: "consent_order" },
    // CFPB sues in federal court before settlement — pending/litigation
    // status markers indicate contested litigation rather than a consent order.
    { pattern: /\bpending\s+litigation\b/i, canonical: "litigation" },
    { pattern: /\blitigation\b/i, canonical: "litigation" },
    { pattern: /\bcomplaint\s+filed\b/i, canonical: "litigation" },
  ],
  FTC: [
    { pattern: /\badministrative\s+complaint\b/i, canonical: "administrative_proceeding" },
    { pattern: /\bproposed\s+order\b/i, canonical: "consent_order" },
    { pattern: /\bfinal\s+order\b/i, canonical: "consent_order" },
  ],
  FINRA: [
    { pattern: /\bacceptance[,\s]+waiver[,\s]+and\s+consent\b/i, canonical: "consent_order" },
    { pattern: /\bawc\b/i, canonical: "consent_order" },
    { pattern: /\boffer\s+of\s+settlement\b/i, canonical: "consent_order" },
  ],
  FINCEN: [
    { pattern: /\bassessment\b/i, canonical: "civil_penalty" },
  ],
  OCC: [],
};

export function classifyActionType(
  agency: Agency,
  rawActionType: string | undefined,
  hints: string[] = [],
): ActionType {
  const haystack = [rawActionType ?? "", ...hints].join(" \n ").trim();
  if (!haystack) return "other";

  for (const rule of AGENCY_RULES[agency]) {
    if (rule.pattern.test(haystack)) return rule.canonical;
  }
  for (const rule of SHARED_RULES) {
    if (rule.pattern.test(haystack)) return rule.canonical;
  }
  return "other";
}
