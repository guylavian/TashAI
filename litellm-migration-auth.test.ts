/**
 * F2 helper: exercises the trust-boundary rule (spec B1) with RELAY_API_KEY set.
 * Spawned by litellm-migration.test.ts as a child process (env must precede
 * `src/config` import) — not meant to be run standalone, but works if you do:
 * `RELAY_API_KEY=k npx tsx litellm-migration-auth.test.ts`.
 */
import assert from "assert";
import { buildApp } from "./src/index";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}: ${detail ?? "assertion failed"}`);
  }
}

async function main() {
  assert.strictEqual(process.env.RELAY_API_KEY, "k", "RELAY_API_KEY must be set for this process");
  const app = await buildApp();
  try {
    try {
      const noBearer = await app.inject({ method: "POST", url: "/compute" });
      assert.strictEqual(noBearer.statusCode, 401, "POST /compute without bearer → 401");
      report("POST /compute without bearer → 401", true);
    } catch (err) {
      report("POST /compute without bearer → 401", false, err instanceof Error ? err.message : String(err));
    }

    try {
      const wrongBearer = await app.inject({
        method: "POST",
        url: "/compute",
        headers: { authorization: "Bearer wrong-key" },
      });
      assert.strictEqual(wrongBearer.statusCode, 401, "POST /compute with wrong bearer → 401");
      report("POST /compute with wrong bearer → 401", true);
    } catch (err) {
      report("POST /compute with wrong bearer → 401", false, err instanceof Error ? err.message : String(err));
    }

    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      assert.strictEqual(health.statusCode, 200, "GET /health without bearer → 200 (excluded route, B1)");
      report("GET /health without bearer → 200", true);
    } catch (err) {
      report("GET /health without bearer → 200", false, err instanceof Error ? err.message : String(err));
    }

    try {
      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      assert.strictEqual(metrics.statusCode, 200, "GET /metrics without bearer → 200 (excluded route, B1)");
      report("GET /metrics without bearer → 200", true);
    } catch (err) {
      report("GET /metrics without bearer → 200", false, err instanceof Error ? err.message : String(err));
    }
  } finally {
    await app.close();
  }

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
