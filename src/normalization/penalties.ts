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

const MONEY_RE = /\$\s?([\d,]+(?:\.\d+)?)\s*(million|mln|m|billion|bn|b|thousand|k)?\b/gi;

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
    return Number.isFinite(rawAmount) ? rawAmount : undefined;
  }
  const trimmed = String(rawAmount).trim();
  if (!trimmed) return undefined;
  const match = MONEY_RE.exec(trimmed.replace(/,/g, "")) ?? null;
  MONEY_RE.lastIndex = 0;
  if (!match) return undefined;
  const numeric = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(numeric)) return undefined;
  return applyMultiplier(numeric, match[2]);
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

  const cleaned = text.replace(/,/g, "");
  const components: PenaltyComponent[] = [];
  const matches = Array.from(cleaned.matchAll(MONEY_RE));

  for (const m of matches) {
    const numeric = Number.parseFloat(m[1] ?? "");
    if (!Number.isFinite(numeric)) continue;
    const amount = applyMultiplier(numeric, m[2]);

    const windowStart = Math.max(0, (m.index ?? 0) - 80);
    const windowEnd = Math.min(cleaned.length, (m.index ?? 0) + 60);
    const windowText = cleaned.slice(windowStart, windowEnd);

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
  return {
    amount: total,
    currency: "USD",
    breakdown: components,
    origin: components.length === 1 ? "observed" : "inferred",
  };
}
