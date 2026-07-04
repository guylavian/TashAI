/**
 * TDD red-state tests for SPEC-litellm-migration.md section F.
 * Plain asserts, run with `npx tsx litellm-migration.test.ts`. No LM Studio, no
 * network — uses buildApp()+app.inject() (D1) and direct service imports.
 *
 * ASSUMPTION (spec is silent on the exact signature): the routing engine's
 * `classify()` gains tenant as an optional THIRD positional argument —
 * `classify(messages, source?, tenant?)` — so F6 (cache key must include
 * tenant, per spec C4) can be exercised via createClassifier directly. If the
 * implementer chooses a different shape (e.g. an options bag), update F6 only.
 *
 * F2 (auth ON) needs RELAY_API_KEY set BEFORE `src/config` is imported, which
 * would pollute this process for F3 (auth OFF). It's spawned as a child
 * process running litellm-migration-auth.test.ts with the env var injected.
 */
import assert from "assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildApp } from "./src/index";
import { put, get, slice } from "./src/services/artifactStore";
import { createClassifier, type ChatFn } from "./src/services/routing/engine";
import { infraTaxonomy } from "./src/services/routing/infra-taxonomy";

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
async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    report(name, true);
  } catch (err) {
    report(name, false, err instanceof Error ? err.message : String(err));
  }
}

// ── F1: deleted surface ──────────────────────────────────────────────────────
async function deletedSurface() {
  const app = await buildApp();
  try {
    const asyncRes = await app.inject({ method: "POST", url: "/compute/async" });
    assert.strictEqual(asyncRes.statusCode, 404, "POST /compute/async must be gone (A2)");
    const webhooksRes = await app.inject({ method: "GET", url: "/webhooks" });
    assert.strictEqual(webhooksRes.statusCode, 404, "GET /webhooks must be gone (A2)");
  } finally {
    await app.close();
  }
}

// ── F3: auth off — no RELAY_API_KEY in THIS process ──────────────────────────
async function authOff() {
  assert.strictEqual(process.env.RELAY_API_KEY, undefined, "test process must not have RELAY_API_KEY set");
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/models" });
    assert.notStrictEqual(res.statusCode, 401, "no RELAY_API_KEY → /models must not 401 (5xx if LM Studio down is fine)");
  } finally {
    await app.close();
  }
}

// ── F2: auth on — spawned in a child process (env must precede config import) ─
async function authOn() {
  const helper = path.join(__dirname, "litellm-migration-auth.test.ts");
  const res = spawnSync("npx", ["tsx", helper], {
    encoding: "utf8",
    env: { ...process.env, RELAY_API_KEY: "k" },
  });
  const out = (res.stdout || "") + (res.stderr || "");
  for (const line of out.split("\n")) {
    if (line.startsWith("[PASS]") || line.startsWith("[FAIL]")) console.log(line);
  }
  assert.strictEqual(res.status, 0, `auth child process exited ${res.status}:\n${out}`);
}

// ── F4: tenant isolation on the artifact store (C2) ──────────────────────────
async function tenantIsolation() {
  // Assumed post-migration shape: put(tenant, text, name); get(tenant, hash); slice(tenant, hash, query?, maxChars?).
  const hash = (put as any)("a", "secret payload", "note.txt");
  assert.strictEqual((get as any)("b", hash), undefined, "tenant b must not read tenant a's artifact");
  assert.strictEqual((slice as any)("b", hash), undefined, "tenant b must not slice tenant a's artifact");
  const hit = (get as any)("a", hash);
  assert.ok(hit, "tenant a can read its own artifact");
  assert.strictEqual(hit.text, "secret payload");
}

// ── F5: tenantOf(req) resolution order (C1) ──────────────────────────────────
async function tenantOfResolution() {
  const { tenantOf } = await import("./src/services/tenant");
  const headerWins = tenantOf({ headers: { "x-user-id": "from-header" }, body: { user: "from-body" } } as any);
  assert.strictEqual(headerWins, "from-header", "x-user-id header wins over body.user");

  const bodyFallback = tenantOf({ headers: {}, body: { user: "from-body" } } as any);
  assert.strictEqual(bodyFallback, "from-body", "body.user used when no header");

  const defaultTenant = tenantOf({ headers: {}, body: {} } as any);
  assert.strictEqual(defaultTenant, "default", "\"default\" when neither header nor body.user present");
}

// ── F6: classifier cache key must include tenant (C4) ────────────────────────
async function classifierCacheTenancy() {
  let calls = 0;
  const countingChat: ChatFn = async () => {
    calls++;
    return { choices: [{ message: { content: JSON.stringify({ category: "general", complexity: "medium", confidence: 0.9 }) } }] };
  };
  const { classify } = createClassifier(infraTaxonomy, {
    chat: countingChat,
    classifier: { enabled: true, model: "stub", maxTokens: 60, confidenceThreshold: 0.75, fallbackModel: "" },
  });
  const messages = [{ role: "user" as const, content: "identical text, two tenants, no taxonomy keywords here" }];
  await (classify as any)(messages, undefined, "tenant-a");
  await (classify as any)(messages, undefined, "tenant-b");
  assert.strictEqual(calls, 2, "same text, different tenants → no cross-tenant cache hit (2 upstream calls)");
}

// ── F7: buildApp shape ────────────────────────────────────────────────────────
async function buildAppShape() {
  const app = await buildApp();
  try {
    assert.ok(app, "buildApp() resolves to a FastifyInstance");
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: {} });
    assert.notStrictEqual(res.statusCode, 404, "POST /v1/chat/completions route must exist");
    assert.strictEqual(app.server.listening, false, "buildApp() must not call listen()");
  } finally {
    await app.close();
  }
}

async function main() {
  await run("F1 deleted surface (compute/async, webhooks) → 404", deletedSurface);
  await run("F3 auth off → /models not 401", authOff);
  await run("F2 auth on (child process)", authOn);
  await run("F4 tenant isolation on artifact store", tenantIsolation);
  await run("F5 tenantOf resolution order", tenantOfResolution);
  await run("F6 classifier cache key includes tenant", classifierCacheTenancy);
  await run("F7 buildApp resolves, has route, does not listen", buildAppShape);

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
