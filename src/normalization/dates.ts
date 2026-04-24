const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

/**
 * Best-effort parser for messy date strings across agency feeds.
 *
 * Handles:
 *   - ISO 8601 (2024-06-12, 2024-06-12T08:00:00Z)
 *   - US format (June 12, 2024 / Jun 12, 2024 / 06/12/2024)
 *   - RFC 822 (Mon, 12 Jun 2024 08:00:00 GMT)  (via Date parser)
 *
 * Returns a YYYY-MM-DD string or undefined.
 */
export function normalizeDate(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    return value.toISOString().slice(0, 10);
  }

  const trimmed = String(value).trim();
  if (!trimmed) return undefined;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(trimmed);
  if (us) {
    let yearStr = us[3] ?? "";
    if (yearStr.length === 2) yearStr = Number(yearStr) < 50 ? `20${yearStr}` : `19${yearStr}`;
    const month = (us[1] ?? "").padStart(2, "0");
    const day = (us[2] ?? "").padStart(2, "0");
    return `${yearStr}-${month}-${day}`;
  }

  const longForm = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(trimmed);
  if (longForm) {
    const m = MONTHS[(longForm[1] ?? "").toLowerCase()];
    if (m) {
      const day = (longForm[2] ?? "").padStart(2, "0");
      return `${longForm[3]}-${String(m).padStart(2, "0")}-${day}`;
    }
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return undefined;
}
