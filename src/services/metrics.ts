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
  labelNames: ["model", "token_type"] as const, // prompt | completion
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

export const activeRequests = new Gauge({
  name: "relay_active_requests",
  help: "In-flight requests",
  registers: [registry],
});
