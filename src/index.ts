import crypto from "crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config";
import { computeRoutes } from "./routes/compute";
import { modelsRoutes } from "./routes/models";
import { webhooksRoutes } from "./routes/webhooks";
import { openaiCompatRoutes } from "./routes/openai";
import { metricsRoutes } from "./routes/metrics";
import { parseRoutes } from "./routes/parse";
import { remoteRoutes } from "./routes/remote";
import { registerErrorHandler } from "./middleware/errorHandler";
import { ping, chat } from "./services/lmStudio";

const startTime = Date.now();

const loggerConfig =
  process.env.NODE_ENV !== "production"
    ? { level: config.server.logLevel, transport: { target: "pino-pretty", options: { colorize: true } } }
    : { level: config.server.logLevel };

const app = Fastify({ logger: loggerConfig });

async function bootstrap() {
  await app.register(cors, { origin: true });

  // Raw file uploads for POST /parse arrive as octet-stream — buffer them.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) =>
    done(null, body)
  );

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

  // ─── Auth (guards /remote + /parse — arbitrary command / Python execution) ─
  const apiKey = config.server.apiKey;
  if (apiKey) {
    const want = Buffer.from(apiKey);
    app.addHook("onRequest", async (req, reply) => {
      if (!req.url.startsWith("/remote") && !req.url.startsWith("/parse")) return;
      const got = Buffer.from((req.headers.authorization || "").replace(/^Bearer /, ""));
      const ok = got.length === want.length && crypto.timingSafeEqual(got, want);
      if (!ok) return reply.code(401).send({ error: "unauthorized" });
    });
  }

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
  await app.register(parseRoutes); // POST /parse — upload pcap/evtx/log → parsed text
  await app.register(remoteRoutes); // POST /remote — SSH/WinRM log fetch

  await app.listen({ port: config.server.port, host: config.server.host });
  app.log.info(`LLM Relay running at http://${config.server.host}:${config.server.port}`);

  // Warm the hot-path models sequentially (never concurrently — two cold JIT
  // loads race and LM Studio cancels one). Best-effort, non-blocking; keeps the
  // classifier from timing out to the default model on the first request.
  void warmModels();
}

async function warmModels(): Promise<void> {
  if (process.env.WARM_MODELS === "false") return;
  const models = [
    ...new Set(
      [config.classifier.model, config.routing.default, config.routing.simple].filter(Boolean)
    ),
  ] as string[];

  for (const model of models) {
    try {
      app.log.info(`warming ${model}…`);
      await chat(model, [{ role: "user", content: "ok" }], { max_tokens: 1, temperature: 0 });
      app.log.info(`warmed ${model}`);
    } catch (err) {
      app.log.warn(`warm-up skipped for ${model}: ${err instanceof Error ? err.message : "error"}`);
    }
  }
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
