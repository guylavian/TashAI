import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "Validation error",
        details: error.issues.map((e) => ({ path: e.path.join("."), message: e.message })),
      });
    }

    // LM Studio / OpenAI errors
    const anyError = error as Record<string, unknown>;
    if ("status" in anyError && typeof anyError["status"] === "number") {
      const status = anyError["status"] as number;
      const message = typeof anyError["message"] === "string" ? anyError["message"] : "LM Studio error";
      return reply.status(status >= 400 && status < 600 ? status : 502).send({ error: message });
    }

    app.log.error(error);
    return reply.status(500).send({ error: "Internal server error" });
  });
}
