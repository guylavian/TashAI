/**
 * Resolve the end-user (tenant) a request belongs to. The LiteLLM Gateway sits in
 * front and forwards the caller's identity as the `x-user-id` header; the OpenAI
 * `user` body field is the standard fallback. Everything else is single-tenant
 * "default" (standalone dev mode). The id namespaces the artifact store and the
 * classifier / summary caches so tenants never see each other's data.
 *
 * Tenant scope is per-request, not per-connection — resolved fresh from each
 * request's headers/body, so keep-alive connection reuse can't leak an identity.
 */
import type { FastifyRequest } from "fastify";

export function tenantOf(req: FastifyRequest): string {
  const header = req.headers["x-user-id"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader) return fromHeader;
  const bodyUser = (req.body as { user?: unknown } | undefined)?.user;
  if (typeof bodyUser === "string" && bodyUser) return bodyUser;
  return "default";
}
