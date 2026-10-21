import type { ToolChat } from "./chat.js";
import { createOpenAiCompatLlm, createOpenAiCompatToolChat } from "./openaiCompat.js";
import type { Llm } from "./types.js";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";

export const groqModel = (env: NodeJS.ProcessEnv = process.env) => env.GROQ_MODEL || GROQ_DEFAULT_MODEL;

/** Returns a Groq-backed LLM, or undefined when GROQ_API_KEY is not set. */
export function createLlmFromEnv(env: NodeJS.ProcessEnv = process.env): Llm | undefined {
  if (!env.GROQ_API_KEY) return undefined;
  return createOpenAiCompatLlm({
    name: "Groq",
    baseUrl: GROQ_BASE_URL,
    apiKey: () => env.GROQ_API_KEY as string,
    model: () => groqModel(env),
  });
}

/** Groq-backed tool-calling chat, or undefined when GROQ_API_KEY is not set. */
export function createToolChatFromEnv(env: NodeJS.ProcessEnv = process.env): ToolChat | undefined {
  if (!env.GROQ_API_KEY) return undefined;
  return createOpenAiCompatToolChat({
    name: "Groq",
    baseUrl: GROQ_BASE_URL,
    apiKey: () => env.GROQ_API_KEY as string,
    model: () => groqModel(env),
  });
}