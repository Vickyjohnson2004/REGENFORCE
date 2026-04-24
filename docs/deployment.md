# Deployment Runbook — Railway

## 1. Create services

In your Railway project:

1. **Add service → Database → PostgreSQL.**
   - Railway exposes `DATABASE_URL` on the Postgres service's "Variables" tab. Reference it in your app service as `${{Postgres.DATABASE_URL}}`.
2. *(Optional but recommended)* **Add service → Database → Redis.**
   - Expose `REDIS_URL` the same way.
3. **Add service → GitHub Repo** pointing at this repository.

Railway auto-detects the `Dockerfile`. If you prefer Nixpacks, delete the `Dockerfile` and rely on `railway.json`.

## 2. Environment variables

In the app service, set:

```
PORT=${{PORT}}                           # Railway sets this
CONTEXT_AUTH_ENABLED=true
DATABASE_URL=${{Postgres.DATABASE_URL}}
DATABASE_SSL_STRICT=false                # Railway's managed Postgres uses self-signed
REDIS_URL=${{Redis.REDIS_URL}}           # if added
INGEST_ON_STARTUP=true                   # first boot ONLY; switch off afterwards
INGEST_CRON=7 */6 * * *                  # every 6h
DATA_GOV_API_KEY=<your-data.gov-key>     # free, instant signup
ADMIN_INGEST_TOKEN=<32-char-random>      # guards /admin/ingest
LOG_LEVEL=info
```

## 3. Deploy

Push to `main`. Railway runs:

1. `npm ci`
2. `npm run build`
3. `npm run db:migrate` (idempotent — creates `pg_trgm`, tables, indexes)
4. `npm start` (Express + MCP on `$PORT`)

Healthcheck: `GET /health` must return `200`.

## 4. First-boot smoke test

After the first deployment finishes:

```bash
URL=https://<your-railway-app>.up.railway.app

curl -s $URL/health | jq
curl -s $URL/ | jq

# Unauthenticated discovery — must succeed
curl -s -X POST "$URL/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

Then switch `INGEST_ON_STARTUP=false`.

## 5. Register on the Context marketplace

1. Visit https://ctxprotocol.com/contribute.
2. Paste `https://<your-railway-app>.up.railway.app/mcp` as the endpoint.
3. Let the auto-discovery read `tools/list`. You should see 7 tools.
4. Set listing response price to `$0.00` initially for review.
5. Set default execute price to `$0.001`.
6. Stake the minimum `$10` USDC (or `100 × listing price`, whichever is higher).

## 6. Optimize + submit for review

1. Generate a Context API key at Developer → API Keys.
2. Load the `mcp-tool-optimization-skill.md` into Cursor / Claude with:
   - server code path = `./src/server.ts`
   - endpoint = your Railway URL + `/mcp`
   - API key + Tool ID
3. The skill runs the full vertical research, pushes an optimized description, and proves the tool beats free LLMs.
4. Email `grants@ctxprotocol.com` with:
   - Tool ID
   - Endpoint URL
   - GitHub repo URL
   - The five must-win prompts (see `docs/must-win-prompts.md`)
   - Expected evidence fields
   - Wallet address

## 7. Post-review ops

- Raise listing price from `$0.00` to `$0.10`.
- Monitor `ingestion_runs` table weekly:
  ```sql
  select agency, status, actions_new, actions_updated, duration_ms, started_at
    from ingestion_runs
   order by started_at desc
   limit 20;
  ```
- If FINRA / OCC / FinCEN break (zero-result run), re-deploy with patched selectors and call `/admin/ingest`:
  ```bash
  curl -X POST "$URL/admin/ingest" \
    -H "x-admin-token: $ADMIN_INGEST_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"agency":"FINRA"}'
  ```

## 8. Grant payment

- 50% on review pass.
- 50% after 30 days of verified uptime + usage.

Make sure `/health` stays green and the cron keeps writing `ingestion_runs` rows — that's how reviewers will verify both.
