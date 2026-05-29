import crypto from "crypto";
import { config } from "../config";
import type { WebhookRecord } from "../types";

// In-memory store — swap for Redis/BullMQ in production
const store = new Map<string, WebhookRecord>();

export function register(data: Omit<WebhookRecord, "id" | "created_at" | "total_deliveries" | "failed_deliveries">): WebhookRecord {
  const id = crypto.randomUUID();
  const record: WebhookRecord = {
    ...data,
    id,
    created_at: new Date().toISOString(),
    total_deliveries: 0,
    failed_deliveries: 0,
  };
  store.set(id, record);
  return record;
}

export function unregister(id: string): boolean {
  return store.delete(id);
}

export function list(): WebhookRecord[] {
  return Array.from(store.values());
}

export function get(id: string): WebhookRecord | undefined {
  return store.get(id);
}

interface WebhookPayload {
  event: "compute.done" | "compute.error";
  job_id: string;
  timestamp: string;
  data: unknown;
}

export async function deliver(event: WebhookPayload["event"], jobId: string, data: unknown): Promise<void> {
  const targets = list().filter((w) => w.events.includes(event));
  if (targets.length === 0) return;

  const payload: WebhookPayload = {
    event,
    job_id: jobId,
    timestamp: new Date().toISOString(),
    data,
  };

  await Promise.allSettled(targets.map((w) => deliverToWebhook(w, payload)));
}

async function deliverToWebhook(webhook: WebhookRecord, payload: WebhookPayload, attempt = 1): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-llm-relay-event": payload.event,
    "x-llm-relay-delivery": crypto.randomUUID(),
  };

  if (webhook.secret) {
    const sig = crypto.createHmac("sha256", webhook.secret).update(body).digest("hex");
    headers["x-llm-relay-signature"] = `sha256=${sig}`;
  }

  const record = store.get(webhook.id);
  if (!record) return;
  record.total_deliveries++;
  record.last_triggered = new Date().toISOString();

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.webhook.timeoutMs);

    const res = await fetch(webhook.url, {
      method: "POST",
      headers,
      body,
      signal: ac.signal,
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    record.failed_deliveries++;

    if (attempt < config.webhook.maxRetries) {
      const delay = config.webhook.retryDelayMs * Math.pow(2, attempt - 1); // exponential backoff
      await new Promise((r) => setTimeout(r, delay));
      await deliverToWebhook(webhook, payload, attempt + 1);
    }
  }
}
