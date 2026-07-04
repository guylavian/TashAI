import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export interface ModelEndpoint {
  url: string;
  api_key?: string;
}

// Per-model endpoint overrides — fail fast on malformed JSON so a typo doesn't
// silently route every model to the default endpoint.
function parseEndpoints(raw: string): Record<string, ModelEndpoint> {
  if (!raw.trim()) return {}; // MODEL_ENDPOINTS= (empty) means "no overrides", not a config error
  try {
    const obj = JSON.parse(raw) as Record<string, ModelEndpoint>;
    for (const [model, ep] of Object.entries(obj)) {
      if (!ep || typeof ep.url !== "string" || !ep.url) {
        throw new Error(`MODEL_ENDPOINTS["${model}"] must have a non-empty "url"`);
      }
    }
    return obj;
  } catch (err) {
    throw new Error(`Invalid MODEL_ENDPOINTS JSON: ${err instanceof Error ? err.message : err}`);
  }
}

export const config = {
  server: {
    port: parseInt(optional("PORT", "3000"), 10),
    host: optional("HOST", "0.0.0.0"),
    logLevel: optional("LOG_LEVEL", "info"),
    // Bearer token the gateway presents. When set it guards every route except
    // GET /health and GET /metrics. Empty disables auth (standalone dev mode).
    apiKey: optional("RELAY_API_KEY", ""),
  },

  lmStudio: {
    baseUrl: optional("LM_STUDIO_URL", "http://localhost:1234/v1"),
    apiKey: optional("LM_STUDIO_API_KEY", "lm-studio"),
    timeoutMs: parseInt(optional("LM_STUDIO_TIMEOUT_MS", "120000"), 10),
    maxRetries: parseInt(optional("LM_STUDIO_MAX_RETRIES", "2"), 10),
    // Per-model endpoint overrides (e.g. OpenShift AI serves each model on its
    // own route with its own token). JSON: {"model-id":{"url":"https://…/v1","api_key":"…"}}.
    // Models absent from the map use the default baseUrl/apiKey above.
    endpoints: parseEndpoints(optional("MODEL_ENDPOINTS", "{}")),
  },

  classifier: {
    // The small fast model used for routing classification
    model: optional("CLASSIFIER_MODEL", ""),
    confidenceThreshold: parseFloat(optional("CLASSIFIER_CONFIDENCE_THRESHOLD", "0.75")),
    maxTokens: parseInt(optional("CLASSIFIER_MAX_TOKENS", "200"), 10),
    // Generous enough that a cold model load completes instead of falling back
    // to the default model. Lower it if your classifier model stays warm.
    timeoutMs: parseInt(optional("CLASSIFIER_TIMEOUT_MS", "12000"), 10),
    // Second-stage selector model (option B). Empty falls back to ROUTE_DEFAULT
    // in the classifier wrapper. Set to a stronger model to re-classify the
    // low-confidence long tail before defaulting.
    fallbackModel: optional("CLASSIFIER_FALLBACK_MODEL", ""),
    enabled: optional("CLASSIFIER_ENABLED", "true") === "true",
  },

  // Maps infra categories + complexity to model IDs in LM Studio
  routing: {
    default:    optional("ROUTE_DEFAULT",    ""),
    network:    optional("ROUTE_NETWORK",    ""),
    openshift:  optional("ROUTE_OPENSHIFT",  ""),
    windows:    optional("ROUTE_WINDOWS",    ""),
    security:   optional("ROUTE_SECURITY",   ""),
    monitoring: optional("ROUTE_MONITORING", ""),
    automation: optional("ROUTE_AUTOMATION", ""),
    // Complexity overrides — simple → fast model, complex → strongest model
    simple:  optional("ROUTE_SIMPLE",  ""),
    complex: optional("ROUTE_COMPLEX", ""),
  },

  // Chat-history compaction budget (chars/4 ≈ tokens). Over budget → the middle
  // of the conversation is summarized by the tiny `routing.simple` model. 0 = off.
  historyBudgetTokens: parseInt(optional("HISTORY_BUDGET_TOKENS", "3000"), 10),
} as const;

export type Config = typeof config;
