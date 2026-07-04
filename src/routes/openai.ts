/**
 * OpenAI-compatible /v1/chat/completions endpoint.
 * Lets any openai SDK client point at this relay without code changes.
 * "auto" as the model name triggers SLLM classification + routing.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MessageSchema } from "../types";
import { chatWithArtifacts, chatStreamWithArtifacts } from "../services/artifactTools";
import { compactMessages } from "../services/historyCompactor";
import { classify, resolveRoutedModel, routingDecisionLog } from "../services/classifier";
import { tenantOf } from "../services/tenant";
import { activeRequests, recordClassification, recordRequest, requestsTotal } from "../services/metrics";

const BodySchema = z.object({
  model: z.string().default("auto"),
  messages: z.array(MessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  max_tokens: z.number().int().positive().optional().default(2048),
  stream: z.boolean().optional().default(false),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.string().or(z.array(z.string())).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // OpenAI standard end-user field — LiteLLM forwards it; it identifies the tenant
  // (see tenantOf). Accepted here so the schema doesn't reject gateway traffic.
  user: z.string().optional(),
  // Pass tool-calling through verbatim so agentic clients (opencode, etc.) work
  // — the relay only routes; it must not strip the function-calling contract.
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
});

export async function openaiCompatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/chat/completions", async (req, reply) => {
    const tenant = tenantOf(req);
    const body = BodySchema.parse(req.body);
    body.messages = await compactMessages(body.messages, { tenant });
    const useAuto = !body.model || body.model === "auto";
    const start = Date.now();
    activeRequests.inc();

    try {
      let model = body.model;
      let category = "general";

      if (useAuto) {
        const classification = await classify(body.messages, body.metadata?.source as string | undefined, tenant);
        category = classification.category;
        recordClassification(classification);
        // Trust the engine's recommended_model — no redundant route-level gate
        // (see resolveRoutedModel). Don't pass "auto" as a body override.
        model = resolveRoutedModel(undefined, classification);
        req.log.info(routingDecisionLog(classification, model, tenant), "routing decision");

        if (!model) {
          requestsTotal.inc({ model: "none", category, status: "error" });
          return reply.status(503).send({ error: { message: "No model resolved", type: "server_error" } });
        }
      }

      const opts = {
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        ...(body.top_p !== undefined && { top_p: body.top_p }),
        ...(body.stop !== undefined && { stop: body.stop }),
        ...(body.tools !== undefined && { tools: body.tools }),
        ...(body.tool_choice !== undefined && { tool_choice: body.tool_choice }),
      };

      // ── Streaming ──────────────────────────────────────────────────────────
      if (body.stream) {
        reply.raw.setHeader("content-type", "text/event-stream");
        reply.raw.setHeader("cache-control", "no-cache");
        reply.raw.setHeader("connection", "keep-alive");
        // reply.raw bypasses Fastify's send path where @fastify/cors sets this.
        reply.raw.setHeader("access-control-allow-origin", (reply.getHeader("access-control-allow-origin") as string) ?? "*");
        reply.raw.flushHeaders();

        const id = `chatcmpl-${Date.now()}`;
        let completionTokens = 0;
        // Real usage from the final chunk when available; delta count otherwise.
        let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

        // Errors must be caught here — once headers are flushed, letting the
        // exception reach Fastify's error handler crashes with ERR_HTTP_HEADERS_SENT.
        try {
          const stream = await chatStreamWithArtifacts(model, body.messages, opts, tenant);
          for await (const chunk of stream) {
            if (chunk.usage) usage = chunk.usage;
            // The final usage chunk carries no choices — capture usage above and
            // skip it so we don't emit a stray empty delta to the client.
            if (chunk.choices.length === 0) continue;
            const delta = chunk.choices[0]?.delta ?? {};
            if ((delta as { content?: string }).content) completionTokens++;
            const piece = {
              id,
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta, finish_reason: chunk.choices[0]?.finish_reason ?? null }],
            };
            reply.raw.write(`data: ${JSON.stringify(piece)}\n\n`);
          }
          reply.raw.write("data: [DONE]\n\n");
          // Prefer real usage; fall back to the delta count when it isn't returned.
          if (usage) recordRequest({ model, category, status: "ok", startMs: start, usage });
          else recordRequest({ model, category, status: "ok", startMs: start, completionTokens });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "stream error";
          reply.raw.write(`data: ${JSON.stringify({ error: { message, type: "server_error" } })}\n\n`);
          recordRequest({ model, category, status: "error", startMs: start });
        } finally {
          reply.raw.end();
        }
        return;
      }

      // ── Non-streaming ──────────────────────────────────────────────────────
      const completion = await chatWithArtifacts(model, body.messages, opts, tenant);
      recordRequest({ model, category, status: "ok", startMs: start, usage: completion.usage });
      return reply.send(completion);
    } finally {
      activeRequests.dec();
    }
  });
}
