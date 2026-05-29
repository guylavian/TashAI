/**
 * OpenAI-compatible /v1/chat/completions endpoint.
 * Lets any openai SDK client point at this relay without code changes.
 * "auto" as the model name triggers SLLM classification + routing.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MessageSchema } from "../types";
import { chat, chatStream } from "../services/lmStudio";
import { classify } from "../services/classifier";
import { config } from "../config";
import { activeRequests, classifierConfidence, requestDuration, requestsTotal, tokensTotal } from "../services/metrics";

const BodySchema = z.object({
  model: z.string().default("auto"),
  messages: z.array(MessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  max_tokens: z.number().int().positive().optional().default(2048),
  stream: z.boolean().optional().default(false),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.string().or(z.array(z.string())).optional(),
});

export async function openaiCompatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/chat/completions", async (req, reply) => {
    const body = BodySchema.parse(req.body);
    const useAuto = !body.model || body.model === "auto";
    const start = Date.now();
    activeRequests.inc();

    try {
      let model = body.model;
      let category = "general";

      if (useAuto) {
        const classification = await classify(body.messages);
        category = classification.category;
        classifierConfidence.observe({ category }, classification.confidence);
        model =
          classification.confidence >= config.classifier.confidenceThreshold
            ? (classification.recommended_model ?? config.routing.default)
            : config.routing.default;

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
      };

      // ── Streaming ──────────────────────────────────────────────────────────
      if (body.stream) {
        reply.raw.setHeader("content-type", "text/event-stream");
        reply.raw.setHeader("cache-control", "no-cache");
        reply.raw.setHeader("connection", "keep-alive");
        reply.raw.flushHeaders();

        const stream = await chatStream(model, body.messages, opts);
        const id = `chatcmpl-${Date.now()}`;

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta ?? {};
          const piece = {
            id,
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta, finish_reason: chunk.choices[0]?.finish_reason ?? null }],
          };
          reply.raw.write(`data: ${JSON.stringify(piece)}\n\n`);
        }
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();

        requestsTotal.inc({ model, category, status: "ok" });
        requestDuration.observe({ model, category }, Date.now() - start);
        return;
      }

      // ── Non-streaming ──────────────────────────────────────────────────────
      const completion = await chat(model, body.messages, opts);

      requestsTotal.inc({ model, category, status: "ok" });
      requestDuration.observe({ model, category }, Date.now() - start);
      if (completion.usage) {
        tokensTotal.inc({ model, token_type: "prompt" }, completion.usage.prompt_tokens);
        tokensTotal.inc({ model, token_type: "completion" }, completion.usage.completion_tokens);
      }

      return reply.send(completion);
    } finally {
      activeRequests.dec();
    }
  });
}
