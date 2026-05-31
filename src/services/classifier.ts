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
  classifier: {
    ...config.classifier,
    // Default the second-stage selector to the capable default model (gemma) so
    // an uncertain pick gets re-classified by a stronger model before defaulting.
    fallbackModel: config.classifier.fallbackModel || config.routing.default,
  },
});

export const classify: (messages: Message[], source?: string) => Promise<ClassificationResult> =
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
 */
export function resolveRoutedModel(
  bodyModel: string | undefined,
  c: ClassificationResult
): string {
  return bodyModel || c.recommended_model || config.routing.default || "";
}

/**
 * Structured payload for logging an auto-routing decision: what the engine
 * picked (category/complexity/confidence) plus *how* it decided (`reasoning` —
 * e.g. "keyword fast-path", "llm", "llm (second-stage)") and the model the
 * request will actually hit. Shared so every auto route logs the same shape.
 */
export function routingDecisionLog(c: ClassificationResult, model: string) {
  return {
    category: c.category,
    complexity: c.complexity,
    confidence: c.confidence,
    reasoning: c.reasoning,
    recommended_model: c.recommended_model,
    model,
  };
}
