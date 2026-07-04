import { z } from "zod";
// Type-only imports — erased at runtime, so the engine ↔ types reference is a
// pure type cycle with no runtime require loop.
import type { Classification } from "../services/routing/engine";
import type { InfraCategory } from "../services/routing/infra-taxonomy";

export const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  name: z.string().optional(),
});

export const ComputeRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  max_tokens: z.number().int().positive().optional().default(2048),
  stream: z.boolean().optional().default(false),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.string().or(z.array(z.string())).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Message = z.infer<typeof MessageSchema>;
export type ComputeRequest = z.infer<typeof ComputeRequestSchema>;

/**
 * Single source of truth: derived from the engine's generic `Classification`
 * bound to the taxonomy's category union, so a taxonomy change can't leave a
 * stale hand-written union here. Shape: { category, complexity,
 * recommended_model, confidence, reasoning? }. Categories are defined in
 * infra-taxonomy.ts (network/openshift/windows/security/monitoring/automation/
 * general).
 */
export type ClassificationResult = Classification<InfraCategory>;

export interface ComputeResponse {
  id: string;
  model: string;
  content: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  classification?: ClassificationResult;
  latency_ms: number;
  created_at: string;
}

export interface LMStudioModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  capabilities?: {
    chat_completion: boolean;
    text_completion: boolean;
    embeddings: boolean;
  };
}

export interface HealthStatus {
  status: "ok" | "degraded";
  lm_studio: "connected" | "unreachable";
  classifier: "ready" | "unavailable";
  uptime_seconds: number;
  version: string;
}
