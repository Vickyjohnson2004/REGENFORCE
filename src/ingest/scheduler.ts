import cron from "node-cron";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { runAllAdapters } from "./runner.js";

let running = false;

export function startIngestionScheduler(): void {
  if (!cron.validate(config.ingestCron)) {
    logger.warn(
      { ingestCron: config.ingestCron },
      "INGEST_CRON is invalid; scheduler disabled",
    );
    return;
  }

  cron.schedule(config.ingestCron, async () => {
    if (running) {
      logger.warn("Scheduled ingest skipped: previous run still in progress");
      return;
    }
    running = true;
    try {
      logger.info({ cron: config.ingestCron }, "Scheduled ingestion run starting");
      const reports = await runAllAdapters();
      logger.info(
        {
          success: reports.filter((r) => r.status === "success").length,
          partial: reports.filter((r) => r.status === "partial").length,
          error: reports.filter((r) => r.status === "error").length,
        },
        "Scheduled ingestion complete",
      );
    } catch (err) {
      logger.error({ err }, "Scheduled ingestion threw");
    } finally {
      running = false;
    }
  });
  logger.info({ cron: config.ingestCron }, "Ingestion scheduler started");
}

export async function runOnStartupIfConfigured(): Promise<void> {
  if (!config.ingestOnStartup) return;
  logger.info("INGEST_ON_STARTUP=true; running full ingestion");
  try {
    await runAllAdapters();
  } catch (err) {
    logger.error({ err }, "Startup ingestion failed; continuing to serve");
  }
}
