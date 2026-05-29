import type { FastifyInstance } from "fastify";
import { listModels } from "../services/lmStudio";

export async function modelsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/models",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              object: { type: "string" },
              data: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    object: { type: "string" },
                    created: { type: "number" },
                    owned_by: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      const models = await listModels();
      return reply.send({ object: "list", data: models });
    }
  );
}
