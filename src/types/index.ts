import { z } from "zod";

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
  webhook_url: z.string().url().optional(),
});

export const WebhookRegisterSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(["compute.done", "compute.error"])).default(["compute.done", "compute.error"]),
  secret: z.string().optional(),
  description: z.string().optional(),
});

export type Message = z.infer<typeof MessageSchema>;
export type ComputeRequest = z.infer<typeof ComputeRequestSchema>;
export type WebhookRegister = z.infer<typeof WebhookRegisterSchema>;

export interface ClassificationResult {
  category:
    | "network"        // Cisco, Alteon, F5 BigIP/WAF, Checkpoint/PaloAlto/Juniper, BGP, VLANs
    | "openshift"      // OpenShift/OCP, pods, routes, oc CLI, DeploymentConfig, operators
    | "windows"        // AD, DC, DNS, DHCP, GPO, SCCM, Exchange, SharePoint, SCOM, DFSR
    | "security"       // QRadar, Trellix, firewall policy, CVEs, threats, compliance
    | "monitoring"     // Prometheus, Splunk, Omnibus, Grafana, metrics, alerts, capacity
    | "automation"     // Ansible, Terraform, PowerShell, bash, CI/CD, Satellite
    | "general";       // VMware, NetApp, Kafka, Redis, MongoDB, RHBK, RHEL, anything else
  complexity: "simple" | "medium" | "complex";
  recommended_model: string | null;
  confidence: number;
  reasoning?: string | undefined;
}

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

export interface AsyncComputeResponse {
  job_id: string;
  status: "queued";
  webhook_url?: string;
  created_at: string;
}

export interface WebhookRecord {
  id: string;
  url: string;
  events: string[];
  secret?: string;
  description?: string;
  created_at: string;
  last_triggered?: string;
  total_deliveries: number;
  failed_deliveries: number;
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
