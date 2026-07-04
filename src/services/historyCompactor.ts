/**
 * Chat-history compaction. Clients (Open WebUI, the Python CLI) resend the FULL
 * conversation every turn; small local models degrade and latency grows with a
 * long prefix. When the history exceeds a token budget we keep the leading
 * system message(s) + the last 4 turns verbatim and replace the middle with ONE
 * tiny-model summary — so classification (last user message) is untouched and
 * the retrieve_artifact loop still works (artifact hash markers are preserved).
 *
 * Zero-overhead under budget: same shape, same array. Never fails the request —
 * a missing summarizer model or a summarize timeout falls back to plain
 * truncation. Same size/staleness discipline as the classifier/artifact caches.
 */
import crypto from "crypto";
import { config } from "../config";
import { chat as lmChat } from "./lmStudio";
import { tokensSaved } from "./metrics";
import type { Message } from "../types";

// Matches artifactTools.hasArtifactRef — a message referencing a stored artifact.
// Global so we can pull EVERY marker out of a summarized message and re-attach it.
const HASH_RE = /hash=[0-9a-f]{40}/gi;

// Keep the last 4 turns verbatim. A turn ≈ a user message + its assistant reply,
// so ~8 trailing messages; interleaved tool messages ride along in the same slice.
const KEEP_TAIL = 8;
const SUMMARY_TIMEOUT_MS = 10_000;
const SUMMARY_MAX_TOKENS = 300;
const CACHE_MAX_ENTRIES = 100;

// sha1(summarized-content) → summary text. FIFO-bounded; a growing chat only
// re-summarizes when the compacted prefix actually changes.
const summaryCache = new Map<string, string>();

// Loosely-typed chat fn (matches lmStudio.chat and the engine's ChatFn) so tests
// can inject a stub without importing the OpenAI types.
export type CompactChatFn = (
  model: string,
  messages: Message[],
  opts: { temperature?: number; max_tokens?: number; signal?: AbortSignal }
) => Promise<{ choices: Array<{ message?: { content?: string | null } | null }> }>;

interface Deps {
  chat?: CompactChatFn;
  model?: string; // summarizer model; default config.routing.simple
  budget?: number; // token budget; default config.historyBudgetTokens
}

const chars = (msgs: Message[]): number => msgs.reduce((n, m) => n + m.content.length, 0);

function markersIn(msgs: Message[]): string[] {
  const seen = new Set<string>();
  for (const m of msgs) for (const hit of m.content.matchAll(HASH_RE)) seen.add(hit[0].toLowerCase());
  return [...seen];
}

/** Choose where the trailing verbatim window starts (index into `messages`). */
function windowStart(messages: Message[], firstNonSystem: number): number {
  let start = Math.max(firstNonSystem, messages.length - KEEP_TAIL);
  // Tool-call integrity: a `tool` message must stay with the assistant that
  // requested it — never let the window open on a dangling tool result, or the
  // upstream API rejects the tool message with no preceding tool_calls.
  while (start > firstNonSystem && messages[start].role === "tool") start--;
  return start;
}

async function summarize(
  chat: CompactChatFn,
  model: string,
  middle: Message[]
): Promise<string | null> {
  const key = crypto.createHash("sha1").update(middle.map((m) => `${m.role}:${m.content}`).join("\n")).digest("hex");
  const cached = summaryCache.get(key);
  if (cached !== undefined) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
  try {
    const transcript = middle.map((m) => `${m.role}: ${m.content}`).join("\n");
    const completion = await chat(
      model,
      [
        { role: "system", content: "You compress conversation history. Reply with a terse factual summary — key facts, decisions, identifiers, open questions. No preamble." },
        { role: "user", content: `Summarize this earlier conversation excerpt:\n\n${transcript}` },
      ],
      { temperature: 0, max_tokens: SUMMARY_MAX_TOKENS, signal: controller.signal }
    );
    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) return null;
    summaryCache.set(key, text);
    if (summaryCache.size > CACHE_MAX_ENTRIES) {
      const oldest = summaryCache.keys().next().value;
      if (oldest !== undefined) summaryCache.delete(oldest);
    }
    return text;
  } catch {
    return null; // timeout / abort / upstream error → caller truncates instead
  } finally {
    clearTimeout(timer);
  }
}

export async function compactMessages(messages: Message[], deps: Deps = {}): Promise<Message[]> {
  const budget = deps.budget ?? config.historyBudgetTokens;
  if (budget <= 0) return messages; // compaction disabled
  const originalChars = chars(messages);
  if (originalChars / 4 <= budget) return messages; // under budget → zero-overhead passthrough

  let firstNonSystem = 0;
  while (firstNonSystem < messages.length && messages[firstNonSystem].role === "system") firstNonSystem++;

  const start = windowStart(messages, firstNonSystem);
  const system = messages.slice(0, firstNonSystem);
  const middle = messages.slice(firstNonSystem, start);
  const tail = messages.slice(start);
  if (middle.length === 0) return messages; // nothing between system and the kept window

  const model = deps.model ?? config.routing.simple;
  const chat = deps.chat ?? (lmChat as CompactChatFn);
  const markers = markersIn(middle);

  const summary = model ? await summarize(chat, model, middle) : null;
  const noteBody = summary
    ? `Summary of earlier conversation: ${summary}`
    : `[earlier ${middle.length} messages omitted]`;
  // Re-attach artifact markers dropped from the middle so retrieve_artifact still fires.
  const content = markers.length ? `${noteBody}\n${markers.join("\n")}` : noteBody;

  const compacted: Message[] = [...system, { role: "system", content }, ...tail];

  const saved = Math.round((originalChars - chars(compacted)) / 4);
  if (saved > 0) tokensSaved.inc({ reason: "history_compaction" }, saved);
  return compacted;
}
