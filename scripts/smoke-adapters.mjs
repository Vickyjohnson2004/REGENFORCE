// Smoke-tests each adapter against its live upstream endpoint, prints
// per-agency counts and the first 2 respondent names. Does NOT write to DB.
// Run with: node dist/../scripts/smoke-adapters.mjs  (after `npm run build`)

import { SECAdapter } from "../dist/adapters/sec.js";
import { CFPBAdapter } from "../dist/adapters/cfpb.js";
import { FTCAdapter } from "../dist/adapters/ftc.js";
import { FINRAAdapter } from "../dist/adapters/finra.js";
import { FinCENAdapter } from "../dist/adapters/fincen.js";
import { OCCAdapter } from "../dist/adapters/occ.js";

const adapters = [
  new SECAdapter(),
  new CFPBAdapter(),
  new FTCAdapter(),
  new FINRAAdapter(),
  new FinCENAdapter(),
  new OCCAdapter(),
];

for (const adapter of adapters) {
  const started = Date.now();
  process.stdout.write(`[${adapter.agency}] fetching ... `);
  try {
    const res = await adapter.fetchRecent();
    const ms = Date.now() - started;
    console.log(
      `${res.actions.length} actions, ${res.errors.length} errors, ${ms}ms`,
    );
    for (const a of res.actions.slice(0, 2)) {
      console.log(
        `    - ${a.actionId} | ${a.respondent.slice(0, 80)} | ${a.actionType} | ${a.actionDate ?? "no-date"} | $${a.penaltyAmount ?? "?"}`,
      );
    }
    for (const e of res.errors.slice(0, 2)) {
      console.log(`    ! ${e.message}`);
    }
  } catch (err) {
    console.log(`FAILED: ${err.message ?? err}`);
  }
}
