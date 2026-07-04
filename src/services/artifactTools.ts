/**
 * Artifact retrieval loop shared by every chat route.
 *
 * When a message references a stored artifact ("hash=<40-hex>", emitted by the
 * /parse digest), we hand the model a `retrieve_artifact` tool and run a small
 * tool loop so it can pull only the slices it needs — instead of the caller
 * pasting the whole artifact into context. No hash referenced → zero overhead:
 * the wrappers fall straight through to chat()/chatStream() unchanged.
 */
import type OpenAI from "openai";
import type { Message } from "../types";
import { chat, chatStream } from "./lmStudio";
import * as artifactStore from "./artifactStore";
import { tokensSaved } from "./metrics";

type ChatOpts = Parameters<typeof chat>[2];

const HASH_RE = /hash=([0-9a-f]{40})/i;
const MAX_ITERS = 3;

const retrieveTool = {
  type: "function",
  function: {
    name: "retrieve_artifact",
    description:
      "Fetch slices of a large stored artifact (parsed pcap/evtx/log) by its hash. " +
      "Pass an optional `query` to get only matching lines with surrounding context; omit it for the head.",
    parameters: {
      type: "object",
      properties: {
        hash: { type: "string", description: "40-char artifact hash from the parse digest" },
        query: { type: "string", description: "optional case-insensitive substring to search for" },
      },
      required: ["hash"],
    },
  },
};

/** Any message content that references a stored artifact hash. */
export function hasArtifactRef(messages: Message[]): boolean {
  return messages.some((m) => typeof m.content === "string" && HASH_RE.test(m.content));
}

function mergeTools(opts: ChatOpts): ChatOpts {
  const clientTools = (opts?.tools as unknown[]) ?? [];
  return { ...opts, tools: [...clientTools, retrieveTool] };
}

type OAMsg = OpenAI.Chat.ChatCompletionMessageParam;
type ToolCall = OpenAI.Chat.ChatCompletionMessageToolCall;

function isRetrieve(c: ToolCall): boolean {
  return c.type === "function" && c.function.name === "retrieve_artifact";
}

// Execute one retrieve_artifact call → a `tool` message to append. Credits the
// tokens-saved metric with the delta between the full artifact and the slice.
function runRetrieve(call: ToolCall): OAMsg {
  if (call.type !== "function") return { role: "tool", tool_call_id: call.id, content: "unsupported tool call" };
  let hash: string | undefined;
  let query: string | undefined;
  try {
    const args = JSON.parse(call.function.arguments || "{}");
    hash = args.hash;
    query = args.query;
  } catch {
    /* malformed args → treated as miss below */
  }
  const entry = hash ? artifactStore.get(hash) : undefined;
  let content: string;
  if (!entry || !hash) {
    content = "artifact expired or unknown hash";
  } else {
    content = artifactStore.slice(hash, query) ?? "artifact expired or unknown hash";
    const saved = Math.round((entry.text.length - content.length) / 4);
    if (saved > 0) tokensSaved.inc({ reason: "artifact_slice" }, saved);
  }
  return { role: "tool", tool_call_id: call.id, content };
}

// Resolve retrieve_artifact calls in place, returning the (possibly extended)
// message array once the model answers, calls a foreign tool, or hits MAX_ITERS.
// `final` receives the final non-streaming completion when one is available.
async function resolveLoop(
  model: string,
  messages: Message[],
  merged: ChatOpts,
  onFinal?: (c: OpenAI.Chat.ChatCompletion) => void
): Promise<OAMsg[]> {
  const msgs = messages.slice() as unknown as OAMsg[];
  for (let i = 0; i < MAX_ITERS; i++) {
    const completion = await chat(model, msgs as unknown as Message[], merged);
    const m = completion.choices[0]?.message;
    const calls = m?.tool_calls ?? [];
    const hasForeign = calls.some((c) => !isRetrieve(c));
    // No tool call, or a client/foreign tool call → stop and hand back untouched.
    if (calls.length === 0 || hasForeign) {
      onFinal?.(completion);
      return msgs;
    }
    onFinal?.(completion);
    msgs.push(m as OAMsg);
    for (const c of calls) msgs.push(runRetrieve(c));
  }
  return msgs;
}

/** Non-streaming: returns the final completion after resolving any retrieve calls. */
export async function chatWithArtifacts(
  model: string,
  messages: Message[],
  opts: ChatOpts = {}
): Promise<OpenAI.Chat.ChatCompletion> {
  if (!hasArtifactRef(messages)) return chat(model, messages, opts);
  const merged = mergeTools(opts);
  let final: OpenAI.Chat.ChatCompletion | undefined;
  await resolveLoop(model, messages, merged, (c) => (final = c));
  // `final` is set on every iteration; last one is the answer / foreign-tool call.
  return final ?? (await chat(model, messages, merged));
}

/** Streaming: resolve retrieve calls non-streaming, then stream the final answer. */
export async function chatStreamWithArtifacts(
  model: string,
  messages: Message[],
  opts: ChatOpts = {}
): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
  if (!hasArtifactRef(messages)) return chatStream(model, messages, opts);
  const merged = mergeTools(opts);
  const msgs = await resolveLoop(model, messages, merged);
  // Re-issue the final state as a stream so the client still gets SSE. ponytail:
  // regenerates the last answer once (matches the "re-issue last state" spec).
  return chatStream(model, msgs as unknown as Message[], merged);
}
