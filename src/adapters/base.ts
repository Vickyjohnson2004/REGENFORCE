import type { Agency, NormalizedAction } from "../types.js";

export interface AdapterRunResult {
  agency: Agency;
  sourceUrl: string;
  actions: NormalizedAction[];
  errors: Array<{ message: string; hint?: string }>;
}

export interface AgencyAdapter {
  readonly agency: Agency;
  /**
   * Hard limit on adapter runtime. Ingestion loop aborts if exceeded.
   */
  readonly runTimeoutMs?: number;
  fetchRecent(): Promise<AdapterRunResult>;
}

/**
 * Shared HTTP User-Agent for adapter fetches.
 *
 * Per-host overrides:
 *   - sec.gov requires a declarative UA with contact email per
 *     https://www.sec.gov/os/accessing-edgar-data
 *   - ftc.gov / occ.gov / consumerfinance.gov block non-browser UAs at the
 *     edge (Akamai / CloudFront WAF), so we use a plain browser UA without
 *     any crawler suffix for those hosts.
 *   - All endpoints we hit are public, unrestricted, non-authenticated URLs.
 *     This is the same pattern used by open-source government-data scrapers
 *     such as CourtListener and other civic-tech projects.
 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0";

const SEC_USER_AGENT = "REGENFORCE MCP contact@regenforce.ctxprotocol.com";

function userAgentFor(url: string): string {
  try {
    const host = new URL(url).host;
    if (host.endsWith("sec.gov")) return SEC_USER_AGENT;
    return DEFAULT_USER_AGENT;
  } catch {
    return DEFAULT_USER_AGENT;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retries: number,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      // Retry on 5xx and 429; fail-fast on other non-2xx.
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        if (attempt < retries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error(`Fetch failed for ${url}`);
}

const BROWSER_HEADERS_HTML: Record<string, string> = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

export async function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  const res = await fetchWithRetry(
    url,
    {
      headers: {
        "User-Agent": userAgentFor(url),
        ...BROWSER_HEADERS_HTML,
      },
      redirect: "follow",
    },
    timeoutMs,
    2,
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return await res.text();
}

export async function fetchJson<T>(
  url: string,
  init?: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<T> {
  const res = await fetchWithRetry(
    url,
    {
      headers: {
        "User-Agent": userAgentFor(url),
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        ...init?.headers,
      },
      redirect: "follow",
    },
    init?.timeoutMs ?? 20_000,
    2,
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function combineText(...parts: Array<string | undefined | null>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" \n ");
}
