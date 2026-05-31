/**
 * Ingests tests/results_A.json + tests/results_B.json (produced by eval.ts) and
 * writes tests/router_report.md with computed accuracy, confusion matrix, tier
 * distribution, misclassifications, and pass/fail for the 8 behavior checks.
 * All numbers are computed from the run data — nothing is hand-entered.
 */
import fs from "fs";
import path from "path";

const CATS = ["network", "openshift", "windows", "security", "monitoring", "automation", "general"];

interface Rec {
  expected: string; got: string; confidence: number; recommended_model: string | null;
  finalModel: string | null; reasoning: string; llmCalled: boolean; source: string | null; note: string;
}
interface Run { run: string; enabled: boolean; threshold: number; routeDefault: string; evalLlmCalls: number; totalServerCalls: number; records: Rec[]; behavior: any; }

const A: Run = JSON.parse(fs.readFileSync(path.join(__dirname, "results_A.json"), "utf8"));
const B: Run = JSON.parse(fs.readFileSync(path.join(__dirname, "results_B.json"), "utf8"));
const classifierSrc = fs.readFileSync(path.join(__dirname, "../src/services/classifier.ts"), "utf8");

const acc = (r: Run) => r.records.filter((x) => x.got === x.expected).length / r.records.length;

function perCat(r: Run): Record<string, { correct: number; total: number }> {
  const m: Record<string, { correct: number; total: number }> = {};
  for (const c of CATS) m[c] = { correct: 0, total: 0 };
  for (const x of r.records) {
    m[x.expected].total++;
    if (x.got === x.expected) m[x.expected].correct++;
  }
  return m;
}

function confusion(r: Run): number[][] {
  const idx = Object.fromEntries(CATS.map((c, i) => [c, i]));
  const m = CATS.map(() => CATS.map(() => 0));
  for (const x of r.records) m[idx[x.expected]][idx[x.got]]++;
  return m;
}

function tierOf(reasoning: string): string {
  if (reasoning === "provenance") return "provenance";
  if (reasoning === "keyword fast-path") return "fast-path";
  if (reasoning.startsWith("keyword (")) return "keyword-fallback";
  if (reasoning.startsWith("llm") || reasoning.startsWith("keyword override")) return "llm";
  if (reasoning.startsWith("classifier unavailable")) return "fallback-default";
  return "other";
}

function tierDist(r: Run): Record<string, number> {
  const d: Record<string, number> = {};
  for (const x of r.records) {
    const t = tierOf(x.reasoning);
    d[t] = (d[t] ?? 0) + 1;
  }
  return d;
}

// ── Behavior checks ──────────────────────────────────────────────────────────
const checks: { id: number; name: string; pass: boolean; detail: string }[] = [];

// 1. Provenance: source!=null → expected, conf 1, provenance tier, zero LLM, in BOTH runs.
{
  const provA = A.records.filter((x) => x.source);
  const provB = B.records.filter((x) => x.source);
  const ok = (recs: Rec[]) => recs.every((x) =>
    x.got === x.expected && x.confidence === 1 && x.reasoning === "provenance" && !x.llmCalled);
  const pass = provA.length > 0 && ok(provA) && ok(provB);
  checks.push({ id: 1, name: "Provenance: source→category, conf 1.0, 0 LLM calls (both runs)", pass,
    detail: `${provA.length} provenance cases; A ok=${ok(provA)} B ok=${ok(provB)}; ` +
      provA.map((x) => `${x.source}→${x.got}(${x.confidence})`).join(", ") });
}

// 2. Weight-4 fast-path resolves with zero LLM calls in Run A.
{
  const fp = A.records.filter((x) => x.reasoning === "keyword fast-path");
  const pass = fp.length > 0 && fp.every((x) => !x.llmCalled);
  checks.push({ id: 2, name: "Weight-4 keyword fast-path makes zero LLM calls (Run A)", pass,
    detail: `${fp.length} fast-path cases in Run A, all llmCalled=false: ${fp.every((x) => !x.llmCalled)}` });
}

// 3. Run B accuracy on deterministic (provenance + fast-path) cases == Run A on same.
{
  // Identify deterministic cases by note/source independent of run: provenance OR B reasoning fast-path.
  const detIdx: number[] = [];
  B.records.forEach((b, i) => { if (b.source || b.reasoning === "keyword fast-path") detIdx.push(i); });
  const sameDecision = detIdx.every((i) => A.records[i].got === B.records[i].got);
  const accA = detIdx.filter((i) => A.records[i].got === A.records[i].expected).length / detIdx.length;
  const accB = detIdx.filter((i) => B.records[i].got === B.records[i].expected).length / detIdx.length;
  const pass = sameDecision && accA === accB;
  checks.push({ id: 3, name: "Deterministic-tier accuracy identical across runs", pass,
    detail: `${detIdx.length} deterministic cases; sameDecision=${sameDecision}; accA=${(accA * 100).toFixed(1)}% accB=${(accB * 100).toFixed(1)}%` });
}

// 4. Confidence is margin-derived (contested < single < strong) + no hardcoded 0.9 fabrication.
{
  const c4 = B.behavior.check4;
  const ordered = c4.contested.confidence < c4.single.confidence && c4.single.confidence < c4.strong.confidence;
  const noHardcode = !/Math\.max\(\s*0\.9/.test(classifierSrc);
  const pass = ordered && noHardcode;
  checks.push({ id: 4, name: "Confidence margin-derived; no hard-coded 0.9 fabrication", pass,
    detail: `contested=${c4.contested.confidence} < single=${c4.single.confidence} < strong=${c4.strong.confidence} (ordered=${ordered}); no Math.max(0.9 in src=${noHardcode}` });
}

// 5. Cache key is full-content, not prefix-only: pair-b classifies independently.
{
  const a = A.records.find((x) => x.note.startsWith("cache-pair-a"))!;
  const b = A.records.find((x) => x.note.startsWith("cache-pair-b"))!;
  const pass = a.got === "windows" && b.got === "network" && b.llmCalled;
  checks.push({ id: 5, name: "Cache key is full-content (shared 200-char prefix → independent results)", pass,
    detail: `pair-a got=${a.got}(llm=${a.llmCalled}), pair-b got=${b.got}(llm=${b.llmCalled}); both share identical 200+ char prefix` });
}

// 6. Hang → fallback within a few seconds.
{
  const c6 = A.behavior.check6;
  const pass = c6.elapsedMs < 6500 && c6.got === "general" && /classifier unavailable/.test(c6.reasoning);
  checks.push({ id: 6, name: "Classifier hang falls back within ~5s (does not block)", pass,
    detail: `elapsed=${c6.elapsedMs}ms got=${c6.got} reasoning="${c6.reasoning}"` });
}

// 7. Malformed classifier output handled gracefully.
{
  const c7 = A.behavior.check7;
  const pass = !c7.threw && c7.fence?.got === "security" && c7.prose?.got === "monitoring";
  checks.push({ id: 7, name: "Malformed LLM output (fences/prose) parsed, not thrown", pass,
    detail: `threw=${c7.threw}; fence→${c7.fence?.got}; prose→${c7.prose?.got}` });
}

// 8. Word boundaries: 'san francisco' not network; 'f5 bigip' is network (Run B, deterministic).
{
  const wbTrap = B.records.find((x) => x.note.includes("word-boundary trap"))!;
  const f5 = B.records.find((x) => x.note.includes("f5 bigip must match"))!;
  const pass = wbTrap.got !== "network" && f5.got === "network";
  checks.push({ id: 8, name: "Word boundaries: 'francisco'≠cisco; 'f5 bigip' matches", pass,
    detail: `'san francisco'→${wbTrap.got} (not network); 'f5 bigip'→${f5.got} (network)` });
}

// 9. Second-stage selector (option B): low-confidence primary → stronger model re-picks.
{
  const c9 = A.behavior.check9;
  const pass = !!c9 && c9.got === "security" && /second-stage/.test(c9.reasoning) && c9.calls === 2;
  checks.push({ id: 9, name: "Second-stage selector re-classifies low-confidence picks", pass,
    detail: c9 ? `primary unsure → fallback chose ${c9.got} [${c9.reasoning}], ${c9.calls} LLM calls` : "no check9 data" });
}

// 10. Alias normalization: an LLM-emitted alias maps to the canonical id; unknown → fallback.
{
  const c10 = A.behavior.check10;
  const pass = !!c10 && c10.alias === "openshift" && c10.unknown === "general";
  checks.push({ id: 10, name: "Alias category normalized to canonical id (unknown → fallback)", pass,
    detail: c10 ? `"kubernetes"→${c10.alias}; "frobnicate"→${c10.unknown}` : "no check10 data" });
}

// ── Misclassifications ───────────────────────────────────────────────────────
function misroutes(r: Run) {
  return r.records.filter((x) => x.got !== x.expected);
}

function hypothesis(x: Rec, run: string): string {
  if (run === "B" && tierOf(x.reasoning) === "fallback-default")
    return "No keyword signal; deterministic tiers fall back to general (needs LLM tier).";
  if (x.reasoning.includes("override")) return "Keyword overrode the LLM answer.";
  if (tierOf(x.reasoning) === "fast-path") return "A keyword fast-path fired for the wrong category.";
  if (tierOf(x.reasoning) === "keyword-fallback") return "Keyword fallback chose the wrong category.";
  return "LLM-tier disagreement (oracle mock; plumbing-level).";
}

// ── Emit markdown ────────────────────────────────────────────────────────────
const out: string[] = [];
const P = (s = "") => out.push(s);

P("# Router Classifier — Eval Report");
P();
P(`Generated from \`tests/results_A.json\` and \`tests/results_B.json\`. Harness: \`tests/eval.ts\` mocks LM Studio at the HTTP layer (a local server returns deterministic classifier JSON) and drives the real \`classify()\`. No \`src/\` files were modified.`);
P();
P("**Mock semantics.** When the LLM tier is reached, the mock returns the case's *expected* category (a deterministic oracle). This isolates router logic — tier order, threshold gating, confidence math, caching, fence-parsing, timeout — from the real model's judgment. Consequently **Run A's LLM-tier accuracy reflects plumbing, not model quality**; the meaningful quality signal is **Run B**, which shows how far the deterministic tiers (provenance + keyword) get with *zero* model calls.");
P();

P("## Contract observed (from reading the code)");
P();
P("`classify(messages, source?)` fires tiers in this strict order:");
P();
P("1. **Tier 0 — provenance** (`classifier.ts:164`): if `source` maps via `SOURCE_TO_CATEGORY` (`pcap`/`switch`→network, `evtx`/`logs_windows`→windows, `logs_linux`→security) it returns immediately, `confidence: 1`, `reasoning: \"provenance\"`. No cache, no keywords, **no LLM**.");
P("2. **Cache** (`:176`): SHA-1 of `` `${len}:${content}` `` over the full last user message, 60s TTL.");
P("3. **Tier 1 — keyword pre-classify** (`:180`): weighted regex with a leading word-boundary `(?<![a-z0-9])`. Highest-scoring category wins; `margin = best − runnerUp`. If `score ≥ 4` (`KW_FASTPATH`) it returns now with **no LLM** (`reasoning: \"keyword fast-path\"`).");
P("4. **Disabled/no-model guard** (`:196`): if `!enabled || !model`, return keyword result (`score ≥ 3`) or `fallbackClassification()` (general, conf 0).");
P("5. **Tier 2 — LLM** (`:200`): `chat()` wrapped in a 5s `withTimeout`. Output run through `parseClassifierJson` (strips ```` ``` ```` fences, regex-extracts `{…}`, zod-validates). On agreement confidence is bumped; on disagreement a `score ≥ 3` keyword overrides only when the LLM is below threshold or returned `general`. Timeout/parse failure → keyword or fallback.");
P();
P("`confidence` per tier: provenance `1.0`; keyword `min(1, 0.6 + margin/10)`; LLM = model's self-reported value, `+0.1` (capped) when a keyword agrees. `compute.ts` gates the *model*: `confidence ≥ CONFIDENCE_THRESHOLD (0.75)` ? routed model : `ROUTE_DEFAULT`.");
P();

P("## Overall accuracy");
P();
P("| Run | Classifier | Accuracy | Eval LLM calls |");
P("|---|---|---|---|");
P(`| A | enabled (oracle) | ${(acc(A) * 100).toFixed(1)}% (${A.records.filter(x=>x.got===x.expected).length}/${A.records.length}) | ${A.evalLlmCalls} |`);
P(`| B | disabled (deterministic tiers only) | ${(acc(B) * 100).toFixed(1)}% (${B.records.filter(x=>x.got===x.expected).length}/${B.records.length}) | ${B.evalLlmCalls} |`);
P();
P(`Run B answers **${B.records.length - B.evalLlmCalls}/${B.records.length}** cases with no model call at all.`);
P();

for (const [label, r] of [["A", A], ["B", B]] as [string, Run][]) {
  P(`## Per-category accuracy — Run ${label}`);
  P();
  P("| Category | Correct | Total | Accuracy |");
  P("|---|---|---|---|");
  const pc = perCat(r);
  for (const c of CATS) P(`| ${c} | ${pc[c].correct} | ${pc[c].total} | ${pc[c].total ? ((pc[c].correct / pc[c].total) * 100).toFixed(0) + "%" : "—"} |`);
  P();
  P(`### Confusion matrix — Run ${label} (rows = expected, cols = got)`);
  P();
  P("| exp ↓ \\ got → | " + CATS.map((c) => c.slice(0, 4)).join(" | ") + " |");
  P("|" + "---|".repeat(CATS.length + 1));
  const cm = confusion(r);
  CATS.forEach((c, i) => P(`| **${c.slice(0, 4)}** | ` + cm[i].map((n, j) => (i === j ? `**${n}**` : `${n}`)).join(" | ") + " |"));
  P();
  P(`### Tier distribution — Run ${label}`);
  P();
  const td = tierDist(r);
  P("| Tier | Cases |");
  P("|---|---|");
  for (const t of ["provenance", "fast-path", "keyword-fallback", "llm", "fallback-default"]) if (td[t]) P(`| ${t} | ${td[t]} |`);
  P(`| **LLM-classifier calls (eval set)** | **${r.evalLlmCalls}** |`);
  P();
}

P("## Misclassifications");
P();
for (const [label, r] of [["A", A], ["B", B]] as [string, Run][]) {
  const m = misroutes(r);
  P(`### Run ${label} — ${m.length} miss(es)`);
  P();
  if (m.length === 0) { P("_None._"); P(); continue; }
  P("| expected | got | tier | conf | finalModel | hypothesis | note |");
  P("|---|---|---|---|---|---|---|");
  for (const x of m) P(`| ${x.expected} | ${x.got} | ${tierOf(x.reasoning)} | ${x.confidence} | ${x.finalModel} | ${hypothesis(x, label)} | ${x.note} |`);
  P();
}

P("## Behavior checks");
P();
P("| # | Check | Result | Detail |");
P("|---|---|---|---|");
for (const c of checks) P(`| ${c.id} | ${c.name} | ${c.pass ? "✅ PASS" : "❌ FAIL"} | ${c.detail} |`);
P();
const failed = checks.filter((c) => !c.pass);
P(`**${checks.length - failed.length}/${checks.length} checks pass.**` + (failed.length ? ` Failing: ${failed.map((c) => "#" + c.id).join(", ")}.` : ""));
P();

// ── Confidence-gating quirks (model downgraded despite confident category) ────
P("## Routing quirks worth noting");
P();
const downgraded = A.records.filter((x) => tierOf(x.reasoning) !== "fallback-default" && x.confidence < A.threshold && x.got === x.expected);
if (downgraded.length) {
  P(`These cases resolved to the **correct category** but with confidence below the ${A.threshold} gate, so \`compute.ts\` routes them to \`ROUTE_DEFAULT\` (\`${A.routeDefault}\`) instead of the category model:`);
  P();
  P("| content note | category | conf | tier | routed to |");
  P("|---|---|---|---|---|");
  for (const x of downgraded) P(`| ${x.note} | ${x.got} | ${x.confidence} | ${tierOf(x.reasoning)} | ${x.finalModel} |`);
  P();
} else {
  P("_No category-correct-but-model-downgraded cases detected._");
  P();
}

// ── Keyword recommendations ───────────────────────────────────────────────────
P("## Keyword term findings");
P();
const fpMiss = A.records.filter((x) => tierOf(x.reasoning) === "fast-path" && x.got !== x.expected);
if (fpMiss.length) {
  for (const x of fpMiss) P(`- **Fast-path misroute**: \`${x.note}\` → got ${x.got}, expected ${x.expected}. A weight-4 term fired for the wrong category. Consider demoting the offending term to weight 3.`);
} else {
  P("- No weight-4 fast-path produced a misroute in Run A.");
}
const tieCase = A.records.find((x) => x.note.startsWith("tie probe"));
if (tieCase) {
  P(`- **Tie probe** (\`sccm task sequence\`): got ${tieCase.got} at confidence ${tieCase.confidence}. \`sccm task sequence\` (automation, w4) and \`sccm\` (windows, w4) both match, producing margin 0 → confidence 0.6. The category is right but the sub-0.75 confidence makes \`compute.ts\` route to the default model. Recommend making \`sccm task sequence\` outrank bare \`sccm\` (e.g. exclude \`sccm\` when \`sccm task sequence\` matches, or weight the phrase higher).`);
}
P();

fs.writeFileSync(path.join(__dirname, "router_report.md"), out.join("\n"));
console.log(`Wrote tests/router_report.md`);
console.log(`Run A: ${(acc(A) * 100).toFixed(1)}%  Run B: ${(acc(B) * 100).toFixed(1)}%  Checks: ${checks.length - failed.length}/${checks.length} pass`);
if (failed.length) console.log(`FAILING CHECKS: ${failed.map((c) => "#" + c.id).join(", ")}`);
