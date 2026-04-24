import type { ActionStatus } from "../types.js";

/**
 * Normalizes agency-specific status terminology to a canonical set.
 *
 * Canonical statuses: filed | settled | pending | final_order | dismissed | unknown
 */
export function classifyStatus(hints: string[] = []): ActionStatus {
  const haystack = hints.filter(Boolean).join(" \n ").toLowerCase();
  if (!haystack) return "unknown";

  if (/\bdismissed\b|\bdismiss(al|ed)\b|\bvacat(ed|ur)\b/.test(haystack)) return "dismissed";
  if (/\bfinal\s+(order|judgment|decision)\b/.test(haystack)) return "final_order";
  if (/\bsettle(d|ment)\b|\bconsent(ed)?\b|\bstipulation\b|\bagreed\b|\bawc\b|\bacceptance[,\s]+waiver\b/.test(haystack)) {
    return "settled";
  }
  if (/\bpending\b|\bin\s+litigation\b|\bongoing\b|\blitigation\s+release\b|\bcomplaint\s+filed\b/.test(haystack)) {
    return "pending";
  }
  if (/\bfiled\b|\bcharged\b|\binitiat(ed|ion)\b|\bcommenc(ed|ing)\b/.test(haystack)) {
    return "filed";
  }
  return "unknown";
}
