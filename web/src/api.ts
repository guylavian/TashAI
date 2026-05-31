/** Thin client for the LLM relay gateway (streaming + health/models). */

export const RELAY_URL = (import.meta.env.VITE_RELAY_URL ?? "http://localhost:3100").replace(/\/+$/, "");

export interface Classification {
  category: string;
  complexity?: string;
  confidence: number;
  recommended_model?: string | null;
  reasoning?: string;
}

export type StreamEvent =
  | { type: "classification"; classification: Classification }
  | { type: "chunk"; content: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * POST /compute/auto with stream:true and yield each SSE event.
 * The relay emits a `classification` event first, then `chunk`s, then `done`
 * (or `error`). `source` sets metadata.source for Tier-0 provenance routing.
 */
export async function* streamChat(
  messages: ChatMessage[],
  opts: { source?: string; signal?: AbortSignal } = {}
): AsyncGenerator<StreamEvent> {
  const body: Record<string, unknown> = {
    messages,
    stream: true,
    max_tokens: 2048,
    temperature: 0.2,
  };
  if (opts.source) body.metadata = { source: opts.source };

  const res = await fetch(`${RELAY_URL}/compute/auto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`Relay returned ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the trailing partial line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload) as StreamEvent;
      } catch {
        // partial/garbled SSE frame — skip
      }
    }
  }
}

export interface Health {
  status: string;
  lm_studio: string;
  classifier: string;
  uptime_seconds: number;
  version: string;
}

export async function getHealth(): Promise<Health | null> {
  try {
    const r = await fetch(`${RELAY_URL}/health`);
    return r.ok ? ((await r.json()) as Health) : null;
  } catch {
    return null;
  }
}

export interface ParsedFile {
  filename: string;
  source: string | null;
  bytes: number;
  truncated: boolean;
  text: string;
}

/** Upload one file to the relay's /parse endpoint and get back LLM-ready text. */
export async function parseFile(file: File): Promise<ParsedFile> {
  const res = await fetch(`${RELAY_URL}/parse?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string };
    throw new Error(e.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as ParsedFile;
}

export interface RemoteRequest {
  protocol: "ssh" | "winrm";
  host: string;
  port?: number;
  username: string;
  password?: string;
  keyPath?: string;
  command: string;
}

export interface RemoteResult {
  host: string;
  command: string;
  source: string | null;
  truncated: boolean;
  text: string;
}

/** SSH/WinRM into a host and fetch a log/command output via the relay. */
export async function remoteFetch(req: RemoteRequest): Promise<RemoteResult> {
  const res = await fetch(`${RELAY_URL}/remote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string };
    throw new Error(e.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as RemoteResult;
}

export async function getModels(): Promise<string[]> {
  try {
    const r = await fetch(`${RELAY_URL}/models`);
    if (!r.ok) return [];
    const data = (await r.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}
