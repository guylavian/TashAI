/**
 * Router eval harness. Mocks LM Studio at the HTTP layer (no src/ edits) and
 * drives the real classify() from src/services/classifier.ts.
 *
 *   CLASSIFIER_ENABLED=true  npx tsx tests/eval.ts tests/results_A.json
 *   CLASSIFIER_ENABLED=false npx tsx tests/eval.ts tests/results_B.json
 *
 * The mock is a deterministic ORACLE: when the LLM tier is reached it returns
 * the case's expected category. This isolates ROUTER LOGIC (tier order, gating,
 * confidence, cache, fence-parsing, timeout) from the real model's judgment.
 * Any Run-A miss is therefore attributable to keyword overrides / threshold
 * gating / provenance — exactly the behaviors under review.
 */
import http from "http";
import fs from "fs";
import path from "path";

type Mode = "oracle" | "hang" | "malformed-fence" | "malformed-prose" | "stage2";
const mock = { expected: "general", mode: "oracle" as Mode, calls: 0 };
const PRIMARY_MODEL = "mock-classifier"; // CLASSIFIER_MODEL set below

const server = http.createServer((req, res) => {
  if (req.method === "POST" && (req.url ?? "").includes("/chat/completions")) {
    mock.calls++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reqModel = (() => {
        try { return (JSON.parse(body) as { model?: string }).model; } catch { return undefined; }
      })();
      const send = () => {
        let obj: { category: string; complexity: string; confidence: number } =
          { category: mock.expected, complexity: "medium", confidence: 0.9 };
        // Stage-2 test: primary model answers low-confidence; the fallback model
        // (any other model id) answers confidently with a specific category.
        if (mock.mode === "stage2") {
          obj = reqModel === PRIMARY_MODEL
            ? { category: "general", complexity: "medium", confidence: 0.2 }
            : { category: "security", complexity: "medium", confidence: 0.95 };
        }
        const json = JSON.stringify(obj);
        let content = json;
        if (mock.mode === "malformed-fence") content = "```json\n" + json + "\n```";
        if (mock.mode === "malformed-prose") content = "Sure! Here is the classification: " + json + " — hope that helps.";
        const payload = {
          id: "mock", object: "chat.completion", model: "mock",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (mock.mode === "hang") {
        const t = setTimeout(send, 8000); // longer than classifier's 5s withTimeout
        if (typeof t.unref === "function") t.unref();
      } else send();
    });
  } else {
    res.writeHead(404);
    res.end("{}");
  }
});

// 230-char neutral prefix with NO keyword substrings — used for the cache pair.
const PREFIX =
  "Hello team, I am writing a fairly long background note to describe what we have been observing across the whole estate during the last several business days, and I want to provide plenty of context up front before the specific detail now: ";

interface EvalCase { expected: string; content: string; source: string | null; note: string; }
interface Record_ {
  expected: string; got: string; confidence: number; recommended_model: string | null;
  finalModel: string | null; reasoning: string; llmCalled: boolean; source: string | null; note: string;
}

function loadCases(): EvalCase[] {
  const file = path.join(__dirname, "router_eval.jsonl");
  return fs.readFileSync(file, "utf8").trim().split("\n").map((l) => {
    const c = JSON.parse(l) as EvalCase;
    c.content = c.content.replace("{{PREFIX}}", PREFIX);
    return c;
  });
}

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  // Env MUST be set before requiring config/classifier.
  process.env.LM_STUDIO_URL = `http://127.0.0.1:${port}/v1`;
  process.env.CLASSIFIER_MODEL = "mock-classifier";
  process.env.CLASSIFIER_CONFIDENCE_THRESHOLD = process.env.CLASSIFIER_CONFIDENCE_THRESHOLD ?? "0.75";
  process.env.CLASSIFIER_TIMEOUT_MS = process.env.CLASSIFIER_TIMEOUT_MS ?? "5000"; // keep check 6 deterministic
  process.env.CLASSIFIER_FALLBACK_MODEL = "second-stage-model"; // enables option-B cascade in tests
  // CLASSIFIER_ENABLED comes from the invoking shell.
  const enabled = process.env.CLASSIFIER_ENABLED !== "false";

  const { classify } = require("../src/services/classifier");
  const { config } = require("../src/config");
  const threshold = config.classifier.confidenceThreshold;
  const routeDefault = config.routing.default;

  // Routes now trust the engine's recommended_model (no redundant confidence gate).
  const gateModel = (r: { recommended_model: string | null }) => r.recommended_model ?? routeDefault;

  // ── Eval set ──────────────────────────────────────────────────────────────
  const cases = loadCases();
  const records: Record_[] = [];
  for (const c of cases) {
    mock.mode = "oracle";
    mock.expected = c.expected;
    const before = mock.calls;
    const r = await classify([{ role: "user", content: c.content }], c.source ?? undefined);
    records.push({
      expected: c.expected, got: r.category, confidence: r.confidence,
      recommended_model: r.recommended_model, finalModel: gateModel(r),
      reasoning: r.reasoning, llmCalled: mock.calls > before, source: c.source, note: c.note,
    });
  }
  const evalLlmCalls = records.filter((r) => r.llmCalled).length;

  // ── Behavior checks that need special mock modes / isolation ────────────────
  const behavior: Record<string, unknown> = {};

  if (enabled) {
    // Check 6 — classifier hang must fall back within a few seconds.
    mock.mode = "hang";
    const t0 = Date.now();
    const r6 = await classify([{ role: "user", content: "unique6 please summarize the situation we discussed earlier today" }]);
    behavior.check6 = { elapsedMs: Date.now() - t0, got: r6.category, reasoning: r6.reasoning, confidence: r6.confidence };

    // Check 7 — malformed classifier output (fenced + prose) must parse, not throw.
    mock.mode = "malformed-fence";
    mock.expected = "security";
    let threw = false, r7a: any = null, r7b: any = null;
    try { r7a = await classify([{ role: "user", content: "unique7a evaluate the incident ticket raised earlier" }]); }
    catch { threw = true; }
    mock.mode = "malformed-prose";
    mock.expected = "monitoring";
    try { r7b = await classify([{ role: "user", content: "unique7b please look at the dashboard widget request" }]); }
    catch { threw = true; }
    behavior.check7 = {
      threw,
      fence: r7a ? { got: r7a.category, reasoning: r7a.reasoning } : null,
      prose: r7b ? { got: r7b.category, reasoning: r7b.reasoning } : null,
    };

    // Check 9 — second-stage selector (option B): primary model answers
    // low-confidence with no keyword → stronger model re-classifies and wins.
    mock.mode = "stage2";
    const before9 = mock.calls;
    const r9 = await classify([{ role: "user", content: "unique9 a genuinely ambiguous question with no keyword anywhere" }]);
    behavior.check9 = { got: r9.category, reasoning: r9.reasoning, calls: mock.calls - before9 };
    mock.mode = "oracle";

    // Check 10 — alias normalization: the LLM emits an alias ("kubernetes") as the
    // category value; the engine must map it to the canonical id ("openshift"),
    // not silently coerce it to the fallback.
    mock.mode = "oracle";
    mock.expected = "kubernetes"; // an alias the prompt teaches, not a real id
    const r10a = await classify([{ role: "user", content: "unique10a no keyword here, ambiguous phrasing" }]);
    mock.expected = "frobnicate"; // genuinely unknown → must still fall back
    const r10b = await classify([{ role: "user", content: "unique10b another no-keyword phrasing entirely" }]);
    behavior.check10 = { alias: r10a.category, unknown: r10b.category };
    mock.expected = "general";
  } else {
    // Check 4 — confidence is margin-derived (run with classifier disabled to
    // isolate the keyword tier; no LLM combination).
    const single = await classify([{ role: "user", content: "the cisco switch needs attention" }]); // network3, margin3
    const contested = await classify([{ role: "user", content: "migrate the cisco config to the openshift platform" }]); // network3 vs openshift3 tie
    const strong = await classify([{ role: "user", content: "qradar alert triage now" }]); // security4 fast-path
    behavior.check4 = {
      single: { got: single.category, confidence: single.confidence, reasoning: single.reasoning },
      contested: { got: contested.category, confidence: contested.confidence, reasoning: contested.reasoning },
      strong: { got: strong.category, confidence: strong.confidence, reasoning: strong.reasoning },
    };
  }

  const out = process.argv[2] || (enabled ? "tests/results_A.json" : "tests/results_B.json");
  fs.writeFileSync(out, JSON.stringify({
    run: enabled ? "A" : "B", enabled, threshold, routeDefault,
    evalLlmCalls, totalServerCalls: mock.calls, records, behavior,
  }, null, 2));
  console.log(`[${enabled ? "A" : "B"}] wrote ${out}  (eval cases=${records.length}, eval LLM calls=${evalLlmCalls}, total server calls=${mock.calls})`);

  server.close();
  process.exit(0);
}

main();
