import type { FastifyInstance, FastifyRequest } from "fastify";
import crypto from "crypto";
import { z } from "zod";
import { ComputeRequestSchema } from "../types";
import { chat, chatStream } from "../services/lmStudio";
import { classify } from "../services/classifier";
import * as webhookService from "../services/webhook";
import { config } from "../config";
import {
  activeRequests,
  classifierConfidence,
  requestDuration,
  requestsTotal,
  tokensTotal,
} from "../services/metrics";

type ComputeBody = z.infer<typeof ComputeRequestSchema>;

function parseBody(raw: unknown): ComputeBody {
  return ComputeRequestSchema.parse(raw);
}

export async function computeRoutes(app: FastifyInstance): Promise<void> {
  // ─── Direct compute — model must be provided in body ───────────────────────
  app.post("/compute", async (req, reply) => {
    const body = parseBody(req.body);
    if (!body.model) {
      return reply.status(400).send({ error: "model is required for /compute — use /compute/auto for routing" });
    }

    if (body.stream) return streamResponse(req, reply, body.model, body);

    const start = Date.now();
    const completion = await chat(body.model, body.messages, {
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      top_p: body.top_p,
      stop: body.stop,
    });

    return reply.send(buildResponse(completion, body.model, Date.now() - start));
  });

  // ─── Auto-route via SLLM classifier ────────────────────────────────────────
  app.post("/compute/auto", async (req, reply) => {
    const body = parseBody(req.body);
    const start = Date.now();
    activeRequests.inc();

    try {
      const classification = await classify(body.messages);
      const category = classification.category;

      classifierConfidence.observe({ category }, classification.confidence);

      const model =
        body.model ||
        (classification.confidence >= config.classifier.confidenceThreshold
          ? classification.recommended_model
          : config.routing.default) ||
        "";

      if (!model) {
        requestsTotal.inc({ model: "none", category, status: "error" });
        return reply.status(503).send({
          error: "No model resolved — set ROUTE_DEFAULT or provide a model in the request body",
          classification,
        });
      }

      if (body.stream) return streamResponse(req, reply, model, body, classification);

      const completion = await chat(model, body.messages, {
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        top_p: body.top_p,
        stop: body.stop,
      });

      const latency = Date.now() - start;
      requestsTotal.inc({ model, category, status: "ok" });
      requestDuration.observe({ model, category }, latency);
      if (completion.usage) {
        tokensTotal.inc({ model, token_type: "prompt" }, completion.usage.prompt_tokens);
        tokensTotal.inc({ model, token_type: "completion" }, completion.usage.completion_tokens);
      }

      return reply.send({ ...buildResponse(completion, model, latency), classification });
    } finally {
      activeRequests.dec();
    }
  });

  // ─── Pinned model ──────────────────────────────────────────────────────────
  app.post<{ Params: { modelId: string } }>("/compute/:modelId", async (req, reply) => {
    const body = parseBody(req.body);
    const model = decodeURIComponent(req.params.modelId);
    const start = Date.now();

    if (body.stream) return streamResponse(req, reply, model, body);

    const completion = await chat(model, body.messages, {
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      top_p: body.top_p,
      stop: body.stop,
    });

    return reply.send(buildResponse(completion, model, Date.now() - start));
  });

  // ─── Async compute with webhook delivery ───────────────────────────────────
  app.post("/compute/async", async (req, reply) => {
    const body = parseBody(req.body);
    const jobId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    // Fire-and-forget — resolve in background
    setImmediate(async () => {
      try {
        const start = Date.now();
        const classification = await classify(body.messages);

        const model =
          body.model ||
          (classification.confidence >= config.classifier.confidenceThreshold
            ? classification.recommended_model
            : config.routing.default) ||
          "";

        if (!model) {
          await webhookService.deliver("compute.error", jobId, {
            error: "No model resolved",
            classification,
          });
          return;
        }

        const completion = await chat(model, body.messages, {
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          top_p: body.top_p,
          stop: body.stop,
        });

        const result = { ...buildResponse(completion, model, Date.now() - start), classification, job_id: jobId };

        // Deliver to ad-hoc webhook_url if provided
        if (body.webhook_url) {
          await fetch(body.webhook_url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ event: "compute.done", job_id: jobId, data: result }),
          }).catch(() => {}); // best-effort
        }

        await webhookService.deliver("compute.done", jobId, result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        await webhookService.deliver("compute.error", jobId, { error: message });
      }
    });

    return reply.status(202).send({
      job_id: jobId,
      status: "queued",
      webhook_url: body.webhook_url,
      created_at: createdAt,
    });
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
  req: FastifyRequest,
  reply: any,
  model: string,
  body: ComputeBody,
  classification?: ClassificationResult
) {
  reply.raw.setHeader("content-type", "text/event-stream");
  reply.raw.setHeader("cache-control", "no-cache");
  reply.raw.setHeader("connection", "keep-alive");
  reply.raw.flushHeaders();

  if (classification) {
    reply.raw.write(`data: ${JSON.stringify({ type: "classification", classification })}\n\n`);
  }

  const stream = await chatStream(model, body.messages, {
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    top_p: body.top_p,
    stop: body.stop,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      reply.raw.write(`data: ${JSON.stringify({ type: "chunk", content: delta })}\n\n`);
    }
  }

  reply.raw.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  reply.raw.end();
}
