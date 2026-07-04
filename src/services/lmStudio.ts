import OpenAI from "openai";
import { config } from "../config";
import type { Message, LMStudioModel } from "../types";

let clientInstance: OpenAI | null = null;

function getClient(): OpenAI {
  if (!clientInstance) {
    clientInstance = new OpenAI({
      baseURL: config.lmStudio.baseUrl,
      apiKey: config.lmStudio.apiKey,
      timeout: config.lmStudio.timeoutMs,
      maxRetries: config.lmStudio.maxRetries,
    });
  }
  return clientInstance;
}

// Per-model clients for MODEL_ENDPOINTS overrides (OpenShift AI: each model has
// its own route + token). Models without an override use the default client.
const endpointClients = new Map<string, OpenAI>();

function clientFor(model: string): OpenAI {
  const ep = config.lmStudio.endpoints[model];
  if (!ep) return getClient();
  let client = endpointClients.get(model);
  if (!client) {
    client = new OpenAI({
      baseURL: ep.url,
      apiKey: ep.api_key || config.lmStudio.apiKey,
      timeout: config.lmStudio.timeoutMs,
      maxRetries: config.lmStudio.maxRetries,
    });
    endpointClients.set(model, client);
  }
  return client;
}

// Short TTL cache for the model list. Clients (Open WebUI, OpenAI SDK) poll
// /models often, but the list changes rarely — caching collapses that into one
// upstream round-trip per window. Health checks pass { fresh: true } so liveness
// is never served from cache.
let modelsCache: { data: LMStudioModel[]; ts: number } | null = null;
const MODELS_CACHE_TTL_MS = 10_000;

export async function listModels(opts?: { fresh?: boolean }): Promise<LMStudioModel[]> {
  if (!opts?.fresh && modelsCache && Date.now() - modelsCache.ts < MODELS_CACHE_TTL_MS) {
    return modelsCache.data;
  }
  const client = getClient();
  const response = await client.models.list();
  modelsCache = { data: response.data as LMStudioModel[], ts: Date.now() };
  return modelsCache.data;
}

export async function chat(
  model: string,
  messages: Message[],
  options: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    stop?: string | string[];
    signal?: AbortSignal;
    // Forwarded verbatim so agentic clients (opencode, etc.) can function-call
    // through the relay — without this the model never sees the tools.
    tools?: unknown[];
    tool_choice?: unknown;
  } = {}
): Promise<OpenAI.Chat.ChatCompletion> {
  const client = clientFor(model);
  // Forward the AbortSignal as a per-request option (2nd arg) so a timed-out
  // classifier call actually cancels the in-flight request instead of leaking it.
  return client.chat.completions.create(
    {
      model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 2048,
      ...(options.top_p !== undefined && { top_p: options.top_p }),
      ...(options.stop !== undefined && { stop: options.stop }),
      ...(options.tools && { tools: options.tools as OpenAI.Chat.ChatCompletionTool[] }),
      ...(options.tool_choice !== undefined && {
        tool_choice: options.tool_choice as OpenAI.Chat.ChatCompletionToolChoiceOption,
      }),
      stream: false,
    },
    { signal: options.signal }
  );
}

export async function chatStream(
  model: string,
  messages: Message[],
  options: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    stop?: string | string[];
    tools?: unknown[];
    tool_choice?: unknown;
  } = {}
): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
  const client = clientFor(model);
  return client.chat.completions.create({
    model,
    messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    temperature: options.temperature ?? 0.7,
    max_tokens: options.max_tokens ?? 2048,
    ...(options.top_p !== undefined && { top_p: options.top_p }),
    ...(options.stop !== undefined && { stop: options.stop }),
    ...(options.tools && { tools: options.tools as OpenAI.Chat.ChatCompletionTool[] }),
    ...(options.tool_choice !== undefined && {
      tool_choice: options.tool_choice as OpenAI.Chat.ChatCompletionToolChoiceOption,
    }),
    stream: true,
    // Ask for real token usage in a final chunk so streamed metrics reflect
    // actual tokens, not SSE-delta counts. LM Studio support varies; callers
    // fall back to the delta count when no usage chunk arrives.
    stream_options: { include_usage: true },
  });
}

export async function ping(): Promise<boolean> {
  try {
    await listModels({ fresh: true }); // health must reflect live state, not a cached list
    return true;
  } catch {
    return false;
  }
}
