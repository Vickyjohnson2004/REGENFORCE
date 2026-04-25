import type { PenaltyComponent } from "../types.js";

/**
 * Parses free-text penalty descriptions into structured USD components.
 *
 * Handles agency-specific phrasing:
 *   - "$4.2 million", "$1,200,000", "$15M", "USD 500,000"
 *   - "disgorgement of $3.5M plus prejudgment interest of $250,000"
 *   - "civil money penalty of $10 million"
 *   - "restitution of $2,500,000 to consumers"
 *
 * Returns {amount, breakdown} where amount is the sum of all components.
 * If no amount is found, both are undefined. All amounts are USD-normalized.
 */

// Require a `$` that is at the start of the string OR preceded by a
// non-word character so we never match `$` glued to identifiers (e.g.
// `case$48000`). The amount itself is digits with optional commas/decimal,
// optionally followed by a unit suffix.
const MONEY_RE = /(?:^|[^A-Za-z0-9$])\$\s?([\d,]+(?:\.\d+)?)\s*(million|mln|m|billion|bn|b|thousand|k)?\b/gi;

// Sanity cap: any single penalty component above this is almost certainly a
// false positive (an ID, a docket number, a mis-parsed phone number). The
// largest known US financial-regulatory penalties are in the low single-digit
// billions; Capital One's $480 BILLION figure observed in CFPB scraping is
// the canonical false positive this catches.
const MAX_REASONABLE_PENALTY_USD = 25_000_000_000; // $25B

// Numbers this long without an explicit million/billion suffix are almost
// always identifiers (docket/case numbers like 480000000000), not amounts.
const MAX_DIGITS_WITHOUT_SUFFIX = 10;

type Category = PenaltyComponent["type"];

const CATEGORY_MARKERS: { pattern: RegExp; category: Category }[] = [
  { pattern: /disgorgement/i, category: "disgorgement" },
  { pattern: /restitution|consumer\s+redress|consumer\s+refund/i, category: "restitution" },
  { pattern: /prejudgment\s+interest|pre-judgment\s+interest/i, category: "prejudgment_interest" },
  { pattern: /civil\s+(money\s+)?penalty|monetary\s+penalty|fine/i, category: "civil_penalty" },
];

export function parsePenaltyAmount(rawAmount: string | number | null | undefined): number | undefined {
  if (rawAmount === null || rawAmount === undefined) return undefined;
  if (typeof rawAmount === "number") {
    if (!Number.isFinite(rawAmount)) return undefined;
    if (rawAmount > MAX_REASONABLE_PENALTY_USD) return undefined;
    return rawAmount;
  }
  const trimmed = String(rawAmount).trim();
  if (!trimmed) return undefined;
  const match = MONEY_RE.exec(trimmed) ?? null;
  MONEY_RE.lastIndex = 0;
  if (!match) return undefined;
  const rawDigits = (match[1] ?? "").replace(/,/g, "");
  const suffix = match[2];
  const numeric = Number.parseFloat(rawDigits);
  if (!Number.isFinite(numeric)) return undefined;
  if (!suffix && rawDigits.length > MAX_DIGITS_WITHOUT_SUFFIX) return undefined;
  const amount = applyMultiplier(numeric, suffix);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  if (amount > MAX_REASONABLE_PENALTY_USD) return undefined;
  return amount;
}

function applyMultiplier(value: number, suffix: string | undefined): number {
  if (!suffix) return value;
  const s = suffix.toLowerCase();
  if (s === "million" || s === "mln" || s === "m") return value * 1_000_000;
  if (s === "billion" || s === "bn" || s === "b") return value * 1_000_000_000;
  if (s === "thousand" || s === "k") return value * 1_000;
  return value;
}

export interface PenaltyExtractResult {
  amount?: number;
  currency: "USD";
  breakdown?: PenaltyComponent[];
  origin: "observed" | "inferred" | "unknown";
}

export function extractPenalty(text: string | null | undefined): PenaltyExtractResult {
  if (!text) return { currency: "USD", origin: "unknown" };

  // Keep commas in the source so we can detect grouped thousands (real money
  // is usually written `$1,234,567` not `$1234567`); only strip commas inside
  // the number itself when computing the numeric value.
  const components: PenaltyComponent[] = [];
  const matches = Array.from(text.matchAll(MONEY_RE));
  const seenAmounts = new Set<number>();

  for (const m of matches) {
    const rawDigits = (m[1] ?? "").replace(/,/g, "");
    const suffix = m[2];
    const numeric = Number.parseFloat(rawDigits);
    if (!Number.isFinite(numeric)) continue;

    if (!suffix && rawDigits.length > MAX_DIGITS_WITHOUT_SUFFIX) {
      continue;
    }

    const amount = applyMultiplier(numeric, suffix);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (amount > MAX_REASONABLE_PENALTY_USD) continue;

    if (seenAmounts.has(amount)) continue;
    seenAmounts.add(amount);

    const windowStart = Math.max(0, (m.index ?? 0) - 80);
    const windowEnd = Math.min(text.length, (m.index ?? 0) + 60);
    const windowText = text.slice(windowStart, windowEnd);

    let category: Category = "other";
    for (const marker of CATEGORY_MARKERS) {
      if (marker.pattern.test(windowText)) {
        category = marker.category;
        break;
      }
    }
    components.push({ amount, currency: "USD", type: category });
  }

  if (components.length === 0) return { currency: "USD", origin: "unknown" };

  const total = components.reduce((acc, c) => acc + c.amount, 0);
  if (total > MAX_REASONABLE_PENALTY_USD) {
    return { currency: "USD", origin: "unknown" };
  }
  return {
    amount: total,
    currency: "USD",
    breakdown: components,
    origin: components.length === 1 ? "observed" : "inferred",
  };
}
