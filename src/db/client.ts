import pg from "pg";
import { config } from "../config.js";
import { logger } from "../logger.js";

const { Pool } = pg;

function needsSsl(url: string): boolean {
  // Railway internal URLs don't need SSL, but public proxy URLs do.
  // Heuristic: proxy.rlwy.net and common managed providers require SSL.
  return /sslmode=require|rlwy\.net|supabase|render|neon/.test(url);
}

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: needsSsl(config.databaseUrl)
    ? { rejectUnauthorized: config.databaseSslStrict }
    : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  logger.error({ err }, "PG pool error");
});

export async function pingDatabase(): Promise<boolean> {
  try {
    const res = await pool.query("SELECT 1 AS ok");
    return res.rows[0]?.ok === 1;
  } catch (err) {
    logger.error({ err }, "Database ping failed");
    return false;
  }
}

export async function shutdownDatabase(): Promise<void> {
  await pool.end().catch(() => {});
}
