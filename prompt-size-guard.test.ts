/**
 * A "simple" classification must not route to ROUTE_SIMPLE when the TOTAL
 * prompt is large (agent clients wrap a trivial "hi" in a ~13k-token system
 * prompt that overflows the tiny model's context). Guard lives in
 * resolveRoutedModel; threshold ~8000 chars (~2k tokens).
 *
 * Run: ROUTE_SIMPLE=tiny ROUTE_DEFAULT=big npx tsx prompt-size-guard.test.ts
 * (env must come from the CLI — import hoisting runs config before any
 * process.env assignment in this file could take effect)
 */
import assert from "assert";
import { resolveRoutedModel } from "./src/services/classifier";
import type { ClassificationResult, Message } from "./src/types";

const simplePick: ClassificationResult = {
  category: "general",
  complexity: "simple",
  confidence: 0.8,
  recommended_model: "tiny",
  reasoning: "llm",
};

const small: Message[] = [{ role: "user", content: "hi" }];
const big: Message[] = [
  { role: "system", content: "x".repeat(13_000) }, // agent system prompt
  { role: "user", content: "hi" },
];

// Small prompt: tiny model is fine.
assert.strictEqual(resolveRoutedModel(undefined, simplePick, small), "tiny");
console.log("[PASS] small prompt keeps ROUTE_SIMPLE");

// Big prompt: never the tiny model.
const picked = resolveRoutedModel(undefined, simplePick, big);
assert.notStrictEqual(picked, "tiny", `big prompt must not route to ROUTE_SIMPLE (got ${picked})`);
console.log(`[PASS] big prompt avoids ROUTE_SIMPLE (got ${picked})`);

// Explicit caller override always wins, size regardless.
assert.strictEqual(resolveRoutedModel("pinned", simplePick, big), "pinned");
console.log("[PASS] explicit model override still wins");

// Non-simple picks are untouched by the guard.
const domainPick = { ...simplePick, recommended_model: "qwen" };
assert.strictEqual(resolveRoutedModel(undefined, domainPick, big), "qwen");
console.log("[PASS] non-simple pick untouched");

console.log("prompt-size-guard.test.ts: all assertions passed");
