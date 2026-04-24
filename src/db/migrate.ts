import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, shutdownDatabase } from "./client.js";
import { logger } from "../logger.js";

const here = dirname(fileURLToPath(import.meta.url));

// When compiled to dist/db/migrate.js, go up one level and into ../db at repo root.
const candidates = [
  resolve(here, "../../db/schema.sql"),
  resolve(here, "../../../db/schema.sql"),
  resolve(process.cwd(), "db/schema.sql"),
];

function findSchema(): string {
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `Cannot locate db/schema.sql. Tried: ${candidates.join(", ")}`,
  );
}

async function main(): Promise<void> {
  const sql = findSchema();
  logger.info("Running database migration (schema.sql)");
  await pool.query(sql);
  logger.info("Database migration complete");
  await shutdownDatabase();
}

main().catch((err) => {
  logger.error({ err }, "Migration failed");
  process.exit(1);
});
