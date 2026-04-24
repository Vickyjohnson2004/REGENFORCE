import { runAgency, runAllAdapters } from "./runner.js";
import { AGENCIES, type Agency } from "../types.js";
import { shutdownDatabase } from "../db/client.js";
import { logger } from "../logger.js";

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg || arg === "all") {
    const reports = await runAllAdapters();
    logger.info({ reports: reports.map((r) => ({ agency: r.agency, status: r.status, actions: r.actionsIngested + r.actionsUpdated })) }, "CLI ingestion summary");
  } else {
    const agency = arg.toUpperCase() as Agency;
    if (!AGENCIES.includes(agency)) {
      logger.error(`Unknown agency: ${arg}. Valid: ${AGENCIES.join(", ")}`);
      process.exit(2);
    }
    const report = await runAgency(agency);
    logger.info({ report }, "CLI single-agency ingestion summary");
  }
  await shutdownDatabase();
}

main().catch((err) => {
  logger.error({ err }, "Ingestion CLI failed");
  process.exit(1);
});
