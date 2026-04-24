import { randomUUID } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
  type RequestHandler,
} from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { createContextMiddleware } from "@ctxprotocol/sdk";

import { config } from "./config.js";
import { logger } from "./logger.js";
import { pingDatabase, shutdownDatabase } from "./db/client.js";
import { TOOLS } from "./mcp/tools.js";
import { dispatchTool } from "./mcp/handlers.js";
import { AGENCIES, type Agency } from "./types.js";
import { runAgency, runAllAdapters } from "./ingest/runner.js";
import {
  getAgencyCoverage,
  getLastIngestionRun,
} from "./db/repository.js";
import {
  runOnStartupIfConfigured,
  startIngestionScheduler,
} from "./ingest/scheduler.js";

/**
 * Build a fresh MCP Server instance.
 *
 * The MCP SDK's Server is a single-transport object (see
 * shared/protocol.ts → "Already connected to a transport"), so we instantiate
 * one per StreamableHTTP session and wire the shared tool handlers in.
 */
function createMcpServer(): Server {
  const server = new Server(
    { name: config.serverName, version: config.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      const result = await dispatchTool(name, (args ?? {}) as Record<string, unknown>);
      if (!result.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  code: result.error.code,
                  message: result.error.message,
                  field: result.error.field,
                },
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result.data) }],
        structuredContent: result.data,
      };
    },
  );

  return server;
}

// ============================================================================
// HTTP layer
// ============================================================================

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const transports: Record<string, StreamableHTTPServerTransport> = {};

const verifyContextAuth: RequestHandler = config.contextAuthEnabled
  ? createContextMiddleware()
  : (_req, _res, next) => next();

if (!config.contextAuthEnabled) {
  logger.warn(
    "CONTEXT_AUTH_ENABLED=false — Context JWT verification is DISABLED. Set to true in production.",
  );
}

app.get("/health", async (_req: Request, res: Response) => {
  const dbOk = await pingDatabase();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    server: config.serverName,
    version: config.version,
    database: dbOk ? "ok" : "unreachable",
    contextAuthEnabled: config.contextAuthEnabled,
    toolCount: TOOLS.length,
  });
});

app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "REGENFORCE",
    description:
      "Cross-agency financial regulatory enforcement intelligence (SEC, CFPB, FTC, FINRA, FinCEN, OCC).",
    mcpEndpoint: "/mcp",
    health: "/health",
    stats: "/stats",
    tools: TOOLS.map((t) => t.name),
    version: config.version,
  });
});

// ---------------------------------------------------------------------------
// Public /stats — read-only aggregate DB state (no PII, no raw records).
//
// Publicly exposes per-agency action counts, earliest/latest dates, and the
// status + timestamp of the last ingestion run. Serves two purposes:
//   1. Operators can verify the ingestion pipeline is actually running.
//   2. Marketplace reviewers can confirm data integrity before approval
//      (counts here must match `get_agency_coverage` tool output).
// ---------------------------------------------------------------------------
app.get("/stats", async (_req: Request, res: Response) => {
  try {
    const coverage = await getAgencyCoverage();
    const perAgency = await Promise.all(
      AGENCIES.map(async (agency) => {
        const row = coverage.find((c) => c.agency === agency) ?? null;
        const lastRun = await getLastIngestionRun(agency);
        return {
          agency,
          totalActions: row?.totalActions ?? 0,
          earliestAction: row?.earliestAction ?? null,
          latestAction: row?.latestAction ?? null,
          lastIngestedAt: row?.lastIngestedAt ?? lastRun?.completedAt ?? null,
          lastIngestStatus: lastRun?.status ?? null,
          lastIngestError: lastRun?.errorMessage ?? null,
          lastIngestInserted: lastRun?.actionsIngested ?? null,
          lastIngestUpdated: lastRun?.actionsUpdated ?? null,
        };
      }),
    );
    const totalActions = perAgency.reduce((acc, a) => acc + a.totalActions, 0);
    res.json({
      server: config.serverName,
      version: config.version,
      totalActions,
      agenciesCovered: perAgency.filter((a) => a.totalActions > 0).map((a) => a.agency),
      perAgency,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "/stats failed");
    res.status(500).json({
      error: "stats_unavailable",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---------------------------------------------------------------------------
// Admin ingestion trigger (token-guarded).
//
// Allows an operator to force a fresh ingestion run outside the cron window
// (e.g. after a FINRA page redesign). Disabled when ADMIN_INGEST_TOKEN is empty.
// ---------------------------------------------------------------------------

app.post("/admin/ingest", async (req: Request, res: Response) => {
  if (!config.adminIngestToken) {
    res.status(404).json({ error: "Admin ingest not enabled" });
    return;
  }
  const provided = req.header("x-admin-token") ?? "";
  if (provided !== config.adminIngestToken) {
    res.status(401).json({ error: "Invalid admin token" });
    return;
  }
  const body = (req.body ?? {}) as { agency?: string };
  try {
    if (body.agency) {
      const agency = body.agency.toUpperCase() as Agency;
      if (!AGENCIES.includes(agency)) {
        res.status(400).json({ error: `Unknown agency: ${body.agency}` });
        return;
      }
      const report = await runAgency(agency);
      res.json({ report });
      return;
    }
    const reports = await runAllAdapters();
    res.json({ reports });
  } catch (err) {
    logger.error({ err }, "Admin ingest failed");
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "Ingestion failed" });
  }
});

// ---------------------------------------------------------------------------
// MCP endpoint (Streamable HTTP transport).
// ---------------------------------------------------------------------------

app.post("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport;
        logger.debug({ sessionId: id }, "MCP session initialized");
      },
    });
    const server = createMcpServer();
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
      void server.close().catch(() => {});
    };
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session. Send initialize first." },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "Invalid session" });
});

app.delete("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "Invalid session" });
});

// ---------------------------------------------------------------------------
// Error handler (must come last).
// ---------------------------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled Express error");
  if (res.headersSent) return;
  res.status(500).json({
    error: {
      code: "INTERNAL",
      message: err instanceof Error ? err.message : "Internal server error",
    },
  });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  // Keep a plain console line for platform logs even if logger transport misbehaves.
  console.log(`[startup] REGENFORCE booting on port ${config.port}`);

  // 1. Bind the HTTP listener FIRST so /health answers inside Railway's
  //    healthcheck window. Ingestion runs in the background afterwards
  //    because a full 6-agency scrape can take several minutes and would
  //    otherwise block app.listen() past the healthcheck timeout.
  //
  //    Bind to 0.0.0.0 explicitly (instead of Node's IPv6-preferred default)
  //    so Railway's healthcheck host can reach the container.
  const httpServer = app.listen(config.port, "0.0.0.0", () => {
    console.log(`[startup] HTTP listener bound on 0.0.0.0:${config.port}`);
    logger.info(
      {
        port: config.port,
        contextAuthEnabled: config.contextAuthEnabled,
        tools: TOOLS.map((t) => t.name),
        version: config.version,
      },
      `REGENFORCE MCP server listening on port ${config.port}`,
    );
  });
  httpServer.on("error", (err) => {
    logger.error({ err }, "HTTP server error; exiting");
    process.exit(1);
  });

  // 2. Ping the DB out-of-band. A failure here only logs; /health reflects
  //    it via its own ping so Railway's healthcheck will fail the container
  //    if DATABASE_URL is genuinely misconfigured.
  const dbOk = await pingDatabase();
  if (!dbOk) {
    logger.error(
      "Database is unreachable. Verify DATABASE_URL and that `npm run db:migrate` has been executed.",
    );
  }

  // 3. Start the cron and kick off the optional first-boot ingestion as a
  //    background task (fire-and-forget with error logging).
  startIngestionScheduler();
  void runOnStartupIfConfigured().catch((err) => {
    logger.error({ err }, "Startup ingestion failed; scheduler will retry");
  });
}

start().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});

const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "Shutting down");
  await shutdownDatabase();
  process.exit(0);
};

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
