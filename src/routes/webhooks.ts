import type { FastifyInstance } from "fastify";
import { WebhookRegisterSchema } from "../types";
import * as webhookService from "../services/webhook";

export async function webhooksRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks", async (req, reply) => {
    const data = WebhookRegisterSchema.parse(req.body);
    const record = webhookService.register(data);
    return reply.status(201).send(record);
  });

  app.get("/webhooks", async (_req, reply) => {
    return reply.send({ object: "list", data: webhookService.list() });
  });

  app.get<{ Params: { id: string } }>("/webhooks/:id", async (req, reply) => {
    const record = webhookService.get(req.params.id);
    if (!record) return reply.status(404).send({ error: "Webhook not found" });
    return reply.send(record);
  });

  app.delete<{ Params: { id: string } }>("/webhooks/:id", async (req, reply) => {
    const deleted = webhookService.unregister(req.params.id);
    if (!deleted) return reply.status(404).send({ error: "Webhook not found" });
    return reply.status(204).send();
  });
}
