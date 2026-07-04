import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ComputeRequestSchema } from "../types";
import { chatWithArtifacts, chatStreamWithArtifacts } from "../services/artifactTools";
import { compactMessages } from "../services/historyCompactor";
import { classify, resolveRoutedModel, routingDecisionLog } from "../services/classifier";
import { tenantOf } from "../services/tenant";
import {
  activeRequests,
  recordClassification,
  recordRequest,
  requestsTotal,
} from "../services/metrics";

type ComputeBody = z.infer<typeof ComputeRequestSchema>;

function parseBody(raw: unknown): ComputeBody {
  return ComputeRequestSchema.parse(raw);
}

export async function computeRoutes(app: FastifyInstance): Promise<void> {
  // ─── Direct compute — model must be provided in body ───────────────────────
  app.post("/compute", async (req, reply) => {
    const tenant = tenantOf(req);
    const body = parseBody(req.body);
    body.messages = await compactMessages(body.messages, { tenant });
    if (!body.model) {
      return reply.status(400).send({ error: "model is required for /compute — use /compute/auto for routing" });
    }

    const start = Date.now();
    activeRequests.inc();
    try {
      if (body.stream) return await streamResponse(reply, body.model, body, start, "direct", tenant);

      const completion = await chatWithArtifacts(body.model, body.messages, {
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        top_p: body.top_p,
        stop: body.stop,
      }, tenant);
      recordRequest({ model: body.model, category: "direct", status: "ok", startMs: start, usage: completion.usage, user: tenant });
      return reply.send(buildResponse(completion, body.model, Date.now() - start));
    } finally {
      activeRequests.dec();
    }
  });

  // ─── Auto-route via SLLM classifier ────────────────────────────────────────
  app.post("/compute/auto", async (req, reply) => {
    const tenant = tenantOf(req);
    const body = parseBody(req.body);
    body.messages = await compactMessages(body.messages, { tenant });
    const start = Date.now();
    activeRequests.inc();

    try {
      const classification = await classify(body.messages, body.metadata?.source as string | undefined, tenant);
      const category = classification.category;

      recordClassification(classification);

      // Trust the engine: recommended_model is its final decision. The route
      // must not re-gate on confidence (see resolveRoutedModel) — that second
      // gate downgraded good mid-confidence picks to the default model.
      const model = resolveRoutedModel(body.model, classification, body.messages);
      req.log.info(routingDecisionLog(classification, model, tenant), "routing decision");

      if (!model) {
        requestsTotal.inc({ model: "none", category, status: "error" });
        return reply.status(503).send({
          error: "No model resolved — set ROUTE_DEFAULT or provide a model in the request body",
          classification,
        });
      }

      if (body.stream) return await streamResponse(reply, model, body, start, category, tenant, classification);

      const completion = await chatWithArtifacts(model, body.messages, {
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        top_p: body.top_p,
        stop: body.stop,
      }, tenant);

      const latency = Date.now() - start;
      recordRequest({ model, category, status: "ok", startMs: start, usage: completion.usage, user: tenant });
      return reply.send({ ...buildResponse(completion, model, latency), classification });
    } finally {
      activeRequests.dec();
    }
  });

  // ─── Pinned model ──────────────────────────────────────────────────────────
  app.post<{ Params: { modelId: string } }>("/compute/:modelId", async (req, reply) => {
    // /compute/async was removed (webhook delivery deleted) — don't let the
    // parametric route silently treat "async" as a pinned model id; 404 it.
    if (req.params.modelId === "async") return reply.callNotFound();
    const tenant = tenantOf(req);
    const body = parseBody(req.body);
    body.messages = await compactMessages(body.messages, { tenant });
    const model = decodeURIComponent(req.params.modelId);
    const start = Date.now();
    activeRequests.inc();
    try {
      if (body.stream) return await streamResponse(reply, model, body, start, "pinned", tenant);

      const completion = await chatWithArtifacts(model, body.messages, {
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        top_p: body.top_p,
        stop: body.stop,
      }, tenant);
      recordRequest({ model, category: "pinned", status: "ok", startMs: start, usage: completion.usage, user: tenant });
      return reply.send(buildResponse(completion, model, Date.now() - start));
    } finally {
      activeRequests.dec();
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

import type { ClassificationResult } from "../types";
import type OpenAI from "openai";

function buildResponse(
  completion: OpenAI.Chat.ChatCompletion,
  model: string,
  latencyMs: number,
  classification?: ClassificationResult
) {
  return {
    id: completion.id,
    model,
    content: completion.choices[0]?.message?.content ?? "",
    usage: completion.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    classification,
    latency_ms: latencyMs,
    created_at: new Date().toISOString(),
  };
}

async function streamResponse(
  reply: any,
  model: string,
  body: ComputeBody,
  start: number,
  category: string,
  tenant: string,
  classification?: ClassificationResult
) {
  reply.raw.setHeader("content-type", "text/event-stream");
  reply.raw.setHeader("cache-control", "no-cache");
  reply.raw.setHeader("connection", "keep-alive");
  // Writing to reply.raw bypasses Fastify's send path, where @fastify/cors adds
  // this header — so forward it manually or the browser blocks the SSE response.
  reply.raw.setHeader("access-control-allow-origin", (reply.getHeader("access-control-allow-origin") as string) ?? "*");
  reply.raw.flushHeaders();

  if (classification) {
    reply.raw.write(`data: ${JSON.stringify({ type: "classification", classification })}\n\n`);
  }

  let completionTokens = 0;
  // Captured from the final usage chunk (empty choices) when LM Studio provides
  // it; otherwise we degrade to the delta count below.
  let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
  try {
    const stream = await chatStreamWithArtifacts(model, body.messages, {
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      top_p: body.top_p,
      stop: body.stop,
    }, tenant);

    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        completionTokens++;
        reply.raw.write(`data: ${JSON.stringify({ type: "chunk", content: delta })}\n\n`);
      }
    }

    reply.raw.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    // Prefer real usage; fall back to the delta count when it isn't returned.
    if (usage) recordRequest({ model, category, status: "ok", startMs: start, usage, user: tenant });
    else recordRequest({ model, category, status: "ok", startMs: start, completionTokens, user: tenant });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "stream error";
    reply.raw.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    recordRequest({ model, category, status: "error", startMs: start, user: tenant });
  } finally {
    reply.raw.end();
  }
}
