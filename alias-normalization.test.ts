/**
 * Focused test for the alias→id normalization fix (Task 1) in the routing engine.
 * Feeds category values a small model realistically emits (aliases the prompt
 * teaches, case/punctuation variants) through the REAL engine + taxonomy with a
 * stubbed `chat`, and asserts they resolve to the canonical category instead of
 * being silently coerced to the fallback ("general").
 */
import { createClassifier, type ChatFn } from "./src/services/routing/engine";
import { infraTaxonomy } from "./src/services/routing/infra-taxonomy";

// Stub chat: always returns the given category as confident JSON.
function chatReturning(category: string): ChatFn {
  return async () => ({
    choices: [
      { message: { content: JSON.stringify({ category, complexity: "medium", confidence: 0.95 }) } },
    ],
  });
}

function makeClassifier(category: string) {
  return createClassifier(infraTaxonomy, {
    chat: chatReturning(category),
    classifier: {
      enabled: true,
      model: "stub-classifier",
      maxTokens: 200,
      confidenceThreshold: 0.75,
      timeoutMs: 5000,
      fallbackModel: "", // disable the second-stage selector so we isolate normalization
    },
  });
}

// Neutral query with NO taxonomy keyword, so the keyword tier never fires and we
// observe the LLM path in isolation.
const NEUTRAL = [{ role: "user" as const, content: "hey, can you take a look at this for me?" }];

const cases: Array<{ llmEmits: string; expect: string }> = [
  { llmEmits: "openshift", expect: "openshift" },         // already canonical (idempotent)
  { llmEmits: "kubernetes", expect: "openshift" },        // alias the prompt teaches
  { llmEmits: "k8s", expect: "openshift" },               // alias
  { llmEmits: "Openshift", expect: "openshift" },         // case variant
  { llmEmits: "open_shift", expect: "openshift" },        // punctuation variant
  { llmEmits: "Active Directory", expect: "windows" },    // multi-word alias
  { llmEmits: "frobnicate", expect: "general" },          // genuinely unknown → still fallback
];

async function main() {
  let pass = 0;
  let fail = 0;
  for (const { llmEmits, expect } of cases) {
    const { classify } = makeClassifier(llmEmits);
    const result = await classify(NEUTRAL);
    const ok = result.category === expect;
    if (ok) pass++;
    else fail++;
    console.log(
      `[${ok ? "PASS" : "FAIL"}] LLM emitted "${llmEmits}" → category="${result.category}" ` +
        `(conf ${result.confidence}, model=${result.recommended_model ?? "null"})  expected=${expect}`
    );
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
