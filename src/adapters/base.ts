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

export async function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "REGENFORCE MCP (https://github.com/ctxprotocol)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(
  url: string,
  init?: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "REGENFORCE MCP (https://github.com/ctxprotocol)",
        Accept: "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function combineText(...parts: Array<string | undefined | null>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" \n ");
}
