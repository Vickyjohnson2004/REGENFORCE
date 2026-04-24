/**
 * Entity resolution for cross-agency name linking.
 *
 * Strategy:
 *   1. Aggressive normalization: lowercase, strip punctuation, strip corporate
 *      suffixes, collapse whitespace. Produces `entityKey`.
 *   2. When searching, compute a similarity score using a Jaccard-on-bigrams
 *      similarity + normalized Levenshtein distance. The higher of the two is
 *      the confidence score.
 *
 * Confidence buckets:
 *   - high   >= 0.90  (or exact entity key match)
 *   - medium >= 0.70
 *   - low    <  0.70
 */

const CORPORATE_SUFFIXES = [
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "ltd",
  "limited",
  "llc",
  "llp",
  "lp",
  "plc",
  "co",
  "company",
  "holdings",
  "group",
  "gmbh",
  "ag",
  "sa",
  "nv",
  "bv",
  "pc",
  "pllc",
  "trust",
  "bank",
  "savings",
  "fsb",
  "na",
];

const PUNCT_RE = /[^\p{L}\p{N}\s]/gu;

export function normalizeEntityKey(name: string): string {
  if (!name) return "";
  let normalized = name.normalize("NFKD").toLowerCase();
  normalized = normalized.replace(/&/g, " and ");
  normalized = normalized.replace(PUNCT_RE, " ");
  normalized = normalized.replace(/\s+/g, " ").trim();
  const tokens = normalized
    .split(" ")
    .filter((t) => t.length > 0 && !CORPORATE_SUFFIXES.includes(t));
  return tokens.join(" ").trim();
}

export function generateAliases(name: string): string[] {
  const aliases = new Set<string>();
  if (!name) return [];
  aliases.add(name);
  aliases.add(name.toLowerCase());
  const key = normalizeEntityKey(name);
  if (key) aliases.add(key);

  const parenMatch = name.match(/^(.*?)\s*\(([^)]+)\)\s*(.*)$/);
  if (parenMatch) {
    const [, before = "", inner = "", after = ""] = parenMatch;
    aliases.add(`${before.trim()} ${after.trim()}`.trim());
    aliases.add(inner.trim());
  }

  return Array.from(aliases).filter((a) => a.length >= 2);
}

function bigrams(s: string): Set<string> {
  if (s.length < 2) return new Set([s]);
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

function jaccard(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let intersect = 0;
  for (const t of A) if (B.has(t)) intersect += 1;
  const union = A.size + B.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function levenshteinRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const la = a.length;
  const lb = b.length;
  const max = Math.max(la, lb);
  if (max === 0) return 1;
  const prev = new Array<number>(lb + 1);
  const curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;
  for (let i = 1; i <= la; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= lb; j += 1) prev[j] = curr[j] ?? 0;
  }
  const dist = prev[lb] ?? max;
  return 1 - dist / max;
}

export interface ResolveOptions {
  /** Floor below which matches are rejected. Defaults to 0.55. */
  minScore?: number;
}

export function scoreEntityMatch(query: string, candidate: string): number {
  const qKey = normalizeEntityKey(query);
  const cKey = normalizeEntityKey(candidate);
  if (!qKey || !cKey) return 0;
  if (qKey === cKey) return 1;
  if (cKey.includes(qKey) || qKey.includes(cKey)) {
    const ratio =
      Math.min(qKey.length, cKey.length) / Math.max(qKey.length, cKey.length);
    return 0.85 + 0.15 * ratio;
  }
  const j = jaccard(qKey, cKey);
  const l = levenshteinRatio(qKey, cKey);
  return Math.max(j, l);
}

export function confidenceBucket(score: number): "high" | "medium" | "low" {
  if (score >= 0.9) return "high";
  if (score >= 0.7) return "medium";
  return "low";
}
