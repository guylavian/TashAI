import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry }); // Node.js process CPU/memory/event-loop

export const requestsTotal = new Counter({
  name: "relay_requests_total",
  help: "Total relay requests",
  labelNames: ["model", "category", "status"] as const,
  registers: [registry],
});

export const tokensTotal = new Counter({
  name: "relay_tokens_total",
  help: "Total tokens consumed",
  // user = tenant id from the gateway; one series per real user (bounded
  // cardinality — fine for Prometheus up to ~10k users).
  labelNames: ["model", "token_type", "user"] as const, // prompt | completion
  registers: [registry],
});

export const tokensSaved = new Counter({
  name: "relay_tokens_saved_total",
  help: "Estimated prompt tokens saved by offloading artifacts (~chars/4)",
  labelNames: ["reason"] as const, // artifact_digest | artifact_slice | history_compaction
  registers: [registry],
});

export const requestDuration = new Histogram({
  name: "relay_request_duration_ms",
  help: "Request duration in milliseconds",
  labelNames: ["model", "category"] as const,
  buckets: [200, 500, 1000, 2500, 5000, 10000, 30000, 60000],
  registers: [registry],
});

export const classifierConfidence = new Histogram({
  name: "relay_classifier_confidence",
  help: "Classifier confidence score",
  labelNames: ["category"] as const,
  buckets: [0.1, 0.2, 0.3, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0],
  registers: [registry],
});

export const classifierStageTotal = new Counter({
  name: "relay_classifier_stage_total",
  help: "Classifier decisions by stage — keyword (0 LLM) vs llm (1) vs llm_second_stage (2, the double call) vs provenance/fallback",
  labelNames: ["stage", "category"] as const,
  registers: [registry],
});

export const activeRequests = new Gauge({
  name: "relay_active_requests",
  help: "In-flight requests",
  registers: [registry],
});

/**
 * Coarse cost bucket for a classification, derived from its `reasoning`. The
 * signal that matters is `llm_second_stage` — that's the double LLM call (stage
 * 1 gemma + stage 2 qwen). Watch its share before optimizing the second-stage
 * path: if it's a thin slice the double-call is a non-problem; if it's large the
 * fix is a single strong classifier, not confidence-gating (which re-breaks the
 * confidently-wrong "general" case).
 */
function classifierStage(reasoning?: string): string {
  const r = reasoning ?? "";
  if (r.includes("second-stage")) return "llm_second_stage"; // 2 LLM calls
  if (r.startsWith("provenance")) return "provenance"; // 0 LLM calls
  if (r.startsWith("classifier unavailable")) return "fallback"; // LLM attempted, no result
  if (r.startsWith("keyword") && !r.includes("override")) return "keyword"; // 0 LLM calls
  return "llm"; // single stage-1 call (incl. "llm+keyword agree", "keyword override")
}

/**
 * Record classifier telemetry for one auto-routed request: confidence
 * distribution + decision-stage counter (so the double-call rate is visible in
 * Grafana). Centralized so all three auto routes instrument identically.
 */
export function recordClassification(c: {
  category: string;
  confidence: number;
  reasoning?: string;
}): void {
  classifierConfidence.observe({ category: c.category }, c.confidence);
  classifierStageTotal.inc({ stage: classifierStage(c.reasoning), category: c.category });
}

/**
 * Record a completed request: count, latency, and (if known) token usage.
 * Centralizes the inc/observe calls so every route instruments identically.
 * For streaming, pass completionTokens (delta count) since usage isn't returned.
 */
export function recordRequest(opts: {
  model: string;
  category: string;
  status: "ok" | "error";
  startMs: number;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
  completionTokens?: number;
  user?: string; // tenant id — drives the per-customer consumption panels
}): void {
  const { model, category, status, startMs, usage, completionTokens } = opts;
  const user = opts.user ?? "default";
  requestsTotal.inc({ model, category, status });
  requestDuration.observe({ model, category }, Date.now() - startMs);
  if (usage) {
    tokensTotal.inc({ model, token_type: "prompt", user }, usage.prompt_tokens);
    tokensTotal.inc({ model, token_type: "completion", user }, usage.completion_tokens);
  } else if (completionTokens && completionTokens > 0) {
    tokensTotal.inc({ model, token_type: "completion", user }, completionTokens);
  }
}
