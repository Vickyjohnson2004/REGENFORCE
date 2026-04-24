import type { AgencyAdapter } from "../adapters/base.js";
import { SECAdapter } from "../adapters/sec.js";
import { CFPBAdapter } from "../adapters/cfpb.js";
import { FTCAdapter } from "../adapters/ftc.js";
import { FINRAAdapter } from "../adapters/finra.js";
import { FinCENAdapter } from "../adapters/fincen.js";
import { OCCAdapter } from "../adapters/occ.js";
import { recordIngestionRun, upsertAction } from "../db/repository.js";
import type { Agency } from "../types.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

function allAdapters(): AgencyAdapter[] {
  return [
    new SECAdapter(),
    new CFPBAdapter(),
    new FTCAdapter(),
    new FINRAAdapter(),
    new FinCENAdapter(),
    new OCCAdapter(),
  ];
}

export interface IngestReport {
  agency: Agency;
  status: "success" | "partial" | "error";
  actionsIngested: number;
  actionsUpdated: number;
  errorMessage?: string;
  errors: Array<{ message: string; hint?: string }>;
  sourceUrl?: string;
  durationMs: number;
}

function isEnabled(agency: Agency): boolean {
  return !config.ingestDisable.includes(agency);
}

export async function runAdapter(adapter: AgencyAdapter): Promise<IngestReport> {
  const startedAt = Date.now();
  const log = logger.child({ agency: adapter.agency });
  log.info("Ingestion started");

  let ingested = 0;
  let updated = 0;

  try {
    const result = await withTimeout(adapter.fetchRecent(), adapter.runTimeoutMs ?? 45_000);
    for (const action of result.actions) {
      try {
        const outcome = await upsertAction(action);
        if (outcome === "inserted") ingested += 1;
        else updated += 1;
      } catch (err) {
        result.errors.push({
          message: `Failed to persist ${action.actionId}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const status: IngestReport["status"] =
      result.errors.length === 0
        ? "success"
        : result.actions.length > 0
        ? "partial"
        : "error";

    await recordIngestionRun({
      agency: adapter.agency,
      status,
      actionsIngested: ingested,
      actionsUpdated: updated,
      errorMessage: result.errors[0]?.message,
      sourceUrl: result.sourceUrl,
    });

    const durationMs = Date.now() - startedAt;
    log.info(
      { status, ingested, updated, errors: result.errors.length, durationMs },
      "Ingestion complete",
    );
    return {
      agency: adapter.agency,
      status,
      actionsIngested: ingested,
      actionsUpdated: updated,
      errorMessage: result.errors[0]?.message,
      errors: result.errors,
      sourceUrl: result.sourceUrl,
      durationMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordIngestionRun({
      agency: adapter.agency,
      status: "error",
      actionsIngested: ingested,
      actionsUpdated: updated,
      errorMessage: message,
    });
    log.error({ err }, "Adapter failed");
    return {
      agency: adapter.agency,
      status: "error",
      actionsIngested: ingested,
      actionsUpdated: updated,
      errorMessage: message,
      errors: [{ message }],
      durationMs: Date.now() - startedAt,
    };
  }
}

export async function runAllAdapters(): Promise<IngestReport[]> {
  const reports: IngestReport[] = [];
  const startedAt = Date.now();
  logger.info("Starting full ingestion across all adapters");
  for (const adapter of allAdapters()) {
    if (!isEnabled(adapter.agency)) {
      logger.info({ agency: adapter.agency }, "Skipping (disabled via INGEST_DISABLE)");
      continue;
    }
    const report = await runAdapter(adapter);
    reports.push(report);
  }
  const totalInserted = reports.reduce((a, r) => a + r.actionsIngested, 0);
  const totalUpdated = reports.reduce((a, r) => a + r.actionsUpdated, 0);
  const totalErrors = reports.reduce((a, r) => a + r.errors.length, 0);
  logger.info(
    {
      durationMs: Date.now() - startedAt,
      totalInserted,
      totalUpdated,
      totalErrors,
      perAgency: reports.map((r) => ({
        agency: r.agency,
        status: r.status,
        inserted: r.actionsIngested,
        updated: r.actionsUpdated,
        errors: r.errors.length,
        firstError: r.errors[0]?.message,
      })),
    },
    "Full ingestion complete",
  );
  return reports;
}

export async function runAgency(agency: Agency): Promise<IngestReport> {
  const adapter = allAdapters().find((a) => a.agency === agency);
  if (!adapter) throw new Error(`Unknown agency: ${agency}`);
  return runAdapter(adapter);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Adapter timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
