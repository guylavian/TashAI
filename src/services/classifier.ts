/**
 * Public classifier surface — unchanged API for callers (compute.ts, openai.ts,
 * tests). Binds the generic routing ENGINE to the project's infra TAXONOMY and
 * injects the real `chat` + classifier config.
 *
 * To classify with a different category set, build another taxonomy with
 * `defineTaxonomy(...)` and pass it to `createClassifier(...)`.
 */
import { config } from "../config";
import { chat } from "./lmStudio";
import { createClassifier } from "./routing/engine";
import { infraTaxonomy } from "./routing/infra-taxonomy";
import type { ClassificationResult, Message } from "../types";

const instance = createClassifier(infraTaxonomy, {
  chat,
  // Second-stage selector (fallbackModel) is disabled by default — empty string
  // means the engine's `fbModel && fbModel !== deps.classifier.model` gate never
  // fires. Only set CLASSIFIER_FALLBACK_MODEL when the primary classifier is
  // weak; don't default it here or every low-confidence/"general" pick would
  // silently re-hit ROUTE_DEFAULT (the biggest model) on a second LLM call.
  classifier: config.classifier,
});

export const classify: (messages: Message[], source?: string, tenant?: string) => Promise<ClassificationResult> =
  instance.classify;

export const resolveModel: (
  category: ClassificationResult["category"],
  complexity: ClassificationResult["complexity"]
) => string | null = instance.resolveModel;

/**
 * Resolve the model for an auto-routed request. The engine already folded
 * confidence into `recommended_model` (keyword fast-path, keyword↔LLM override,
 * second-stage selector, fallbackModel-when-uncertain); the route must NOT
 * re-gate on the raw confidence scalar — kwConfidence's 0.6 base is not
 * comparable to the 0.75 threshold and a second gate would silently discard
 * correct keyword/override picks and route them to the default instead.
 * Precedence: explicit caller override → engine decision → configured default.
 *
 * One exception to "trust the engine": the classifier only sees the LAST user
 * message, so an agent client's trivial "hi" wrapped in a ~13k-token system
 * prompt still classifies as simple → ROUTE_SIMPLE — whose small context the
 * total prompt then overflows. A big prompt is by definition not a "simple"
 * request: over ~2k estimated tokens the simple pick is re-resolved as medium.
 */
// ponytail: chars/4 estimate, same heuristic as historyCompactor
const SIMPLE_MAX_PROMPT_CHARS = 8_000;

export function resolveRoutedModel(
  bodyModel: string | undefined,
  c: ClassificationResult,
  messages?: Message[]
): string {
  const pick = bodyModel || c.recommended_model || config.routing.default || "";
  if (bodyModel || !messages || pick !== config.routing.simple) return pick;
  const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
  if (totalChars <= SIMPLE_MAX_PROMPT_CHARS) return pick;
  return resolveModel(c.category, "medium") || config.routing.default || "";
}

/**
 * Structured payload for logging an auto-routing decision: what the engine
 * picked (category/complexity/confidence) plus *how* it decided (`reasoning` —
 * e.g. "keyword fast-path", "llm", "llm (second-stage)") and the model the
 * request will actually hit. Shared so every auto route logs the same shape.
 */
export function routingDecisionLog(c: ClassificationResult, model: string, user?: string) {
  return {
    category: c.category,
    complexity: c.complexity,
    confidence: c.confidence,
    reasoning: c.reasoning,
    recommended_model: c.recommended_model,
    model,
    user,
  };
}
