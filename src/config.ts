import "dotenv/config";

function str(name: string, fallback = ""): string {
  return process.env[name]?.trim() ?? fallback;
}

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: num("PORT", 4010),
  contextAuthEnabled: bool("CONTEXT_AUTH_ENABLED", false),

  databaseUrl: str("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/regenforce"),
  databaseSslStrict: bool("DATABASE_SSL_STRICT", false),

  redisUrl: str("REDIS_URL"),
  redisTtlSeconds: num("REDIS_TTL_SECONDS", 900),

  ingestOnStartup: bool("INGEST_ON_STARTUP", false),
  ingestCron: str("INGEST_CRON", "7 */6 * * *"),
  ingestDisable: str("INGEST_DISABLE")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),

  dataGovApiKey: str("DATA_GOV_API_KEY"),

  adminIngestToken: str("ADMIN_INGEST_TOKEN"),

  logLevel: str("LOG_LEVEL", "info"),

  version: "1.0.0",
  serverName: "regenforce",
} as const;

export type Config = typeof config;
