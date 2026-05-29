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

export async function listModels(): Promise<LMStudioModel[]> {
  const client = getClient();
  const response = await client.models.list();
  return response.data as LMStudioModel[];
}

export async function chat(
  model: string,
  messages: Message[],
  options: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    stop?: string | string[];
  } = {}
): Promise<OpenAI.Chat.ChatCompletion> {
  const client = getClient();
  return client.chat.completions.create({
    model,
    messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    temperature: options.temperature ?? 0.7,
    max_tokens: options.max_tokens ?? 2048,
    ...(options.top_p !== undefined && { top_p: options.top_p }),
    ...(options.stop !== undefined && { stop: options.stop }),
    stream: false,
  });
}

export async function chatStream(
  model: string,
  messages: Message[],
  options: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    stop?: string | string[];
  } = {}
): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
  const client = getClient();
  return client.chat.completions.create({
    model,
    messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    temperature: options.temperature ?? 0.7,
    max_tokens: options.max_tokens ?? 2048,
    ...(options.top_p !== undefined && { top_p: options.top_p }),
    ...(options.stop !== undefined && { stop: options.stop }),
    stream: true,
  });
}

export async function ping(): Promise<boolean> {
  try {
    await listModels();
    return true;
  } catch {
    return false;
  }
}
