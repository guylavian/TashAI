import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config";
import { computeRoutes } from "./routes/compute";
import { modelsRoutes } from "./routes/models";
import { webhooksRoutes } from "./routes/webhooks";
import { openaiCompatRoutes } from "./routes/openai";
import { metricsRoutes } from "./routes/metrics";
import { registerErrorHandler } from "./middleware/errorHandler";
import { ping } from "./services/lmStudio";

const startTime = Date.now();

const loggerConfig =
  process.env.NODE_ENV !== "production"
    ? { level: config.server.logLevel, transport: { target: "pino-pretty", options: { colorize: true } } }
    : { level: config.server.logLevel };

const app = Fastify({ logger: loggerConfig });

async function bootstrap() {
  await app.register(cors, { origin: true });

  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.timeWindowMs,
    errorResponseBuilder: (_req, context) => ({
      error: "Rate limit exceeded",
      limit: context.max,
      reset: new Date((context as any).ttl + Date.now()).toISOString(),
    }),
  });

  registerErrorHandler(app);

  // ─── Health ─────────────────────────────────────────────────────────────
  app.get("/health", async (_req, reply) => {
    const lmStudioUp = await ping();
    const classifierReady = !!config.classifier.model && config.classifier.enabled;

    return reply.send({
      status: lmStudioUp ? "ok" : "degraded",
      lm_studio: lmStudioUp ? "connected" : "unreachable",
      classifier: classifierReady ? "ready" : "unavailable",
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      version: "1.0.0",
    });
  });

  // ─── Routes ─────────────────────────────────────────────────────────────
  await app.register(openaiCompatRoutes); // /v1/chat/completions — openai SDK + Open WebUI compat
  await app.register(computeRoutes);
  await app.register(modelsRoutes);
  await app.register(webhooksRoutes);
  await app.register(metricsRoutes); // GET /metrics — Prometheus scrape endpoint

  await app.listen({ port: config.server.port, host: config.server.host });
  app.log.info(`LLM Relay running at http://${config.server.host}:${config.server.port}`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
