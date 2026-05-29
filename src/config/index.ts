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

export const config = {
  server: {
    port: parseInt(optional("PORT", "3000"), 10),
    host: optional("HOST", "0.0.0.0"),
    logLevel: optional("LOG_LEVEL", "info"),
  },

  lmStudio: {
    baseUrl: optional("LM_STUDIO_URL", "http://localhost:1234/v1"),
    apiKey: optional("LM_STUDIO_API_KEY", "lm-studio"),
    timeoutMs: parseInt(optional("LM_STUDIO_TIMEOUT_MS", "120000"), 10),
    maxRetries: parseInt(optional("LM_STUDIO_MAX_RETRIES", "2"), 10),
  },

  classifier: {
    // The small fast model used for routing classification
    model: optional("CLASSIFIER_MODEL", ""),
    confidenceThreshold: parseFloat(optional("CLASSIFIER_CONFIDENCE_THRESHOLD", "0.75")),
    maxTokens: parseInt(optional("CLASSIFIER_MAX_TOKENS", "200"), 10),
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

  rateLimit: {
    max: parseInt(optional("RATE_LIMIT_MAX", "100"), 10),
    timeWindowMs: parseInt(optional("RATE_LIMIT_WINDOW_MS", "60000"), 10),
  },

  webhook: {
    maxRetries: parseInt(optional("WEBHOOK_MAX_RETRIES", "3"), 10),
    retryDelayMs: parseInt(optional("WEBHOOK_RETRY_DELAY_MS", "2000"), 10),
    timeoutMs: parseInt(optional("WEBHOOK_TIMEOUT_MS", "10000"), 10),
  },
} as const;

export type Config = typeof config;
