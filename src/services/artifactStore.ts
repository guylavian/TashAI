/**
 * In-memory store for large parsed artifacts (pcap/evtx/log text). /parse hands
 * the model a small digest + the artifact's hash instead of pasting the whole
 * thing into context; the model pulls slices back via the retrieve_artifact tool.
 *
 * Bounded (FIFO, like the classifier cache in routing/engine.ts) and TTL'd — this
 * is a scratch buffer, not durable storage, so a lost entry just means the model
 * re-parses. Same size/staleness discipline as the classifier cache.
 */
import crypto from "crypto";

export interface Artifact {
  text: string;
  name: string;
  ts: number;
}

const MAX_ENTRIES = 50;
const TTL_MS = 60 * 60 * 1000; // 1h
const CONTEXT_LINES = 2; // ±N lines around each query match
const DEFAULT_MAX_CHARS = 8000;

const store = new Map<string, Artifact>();

export function put(text: string, name: string): string {
  const hash = crypto.createHash("sha1").update(text).digest("hex");
  store.set(hash, { text, name, ts: Date.now() });
  // Map preserves insertion order → first key is oldest; FIFO-evict over cap.
  if (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  return hash;
}

export function get(hash: string): Artifact | undefined {
  const a = store.get(hash);
  if (!a) return undefined;
  if (Date.now() - a.ts >= TTL_MS) {
    store.delete(hash); // evict on read once stale (TTL is only checked here)
    return undefined;
  }
  return a;
}

/**
 * Return the lines matching `query` (case-insensitive substring) with ±2 lines of
 * context, capped at maxChars. No query → the head of the artifact. Returns
 * undefined if the artifact is gone (expired/unknown); a string otherwise.
 */
export function slice(hash: string, query?: string, maxChars = DEFAULT_MAX_CHARS): string | undefined {
  const a = get(hash);
  if (!a) return undefined;
  if (!query) return a.text.slice(0, maxChars);

  const lines = a.text.split("\n");
  const q = query.toLowerCase();
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(q)) {
      for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(lines.length - 1, i + CONTEXT_LINES); j++) {
        keep.add(j);
      }
    }
  }
  if (keep.size === 0) return `no lines match "${query}"`;

  const idx = [...keep].sort((x, y) => x - y);
  const out: string[] = [];
  let prev = -1;
  let len = 0;
  for (const i of idx) {
    if (prev !== -1 && i > prev + 1) {
      out.push("…"); // gap marker between non-adjacent match blocks
      len += 2;
    }
    if (len + lines[i].length + 1 > maxChars) break;
    out.push(lines[i]);
    len += lines[i].length + 1;
    prev = i;
  }
  return out.join("\n");
}
