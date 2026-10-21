import type { ToolCall, ToolChat } from "./chat.js";
import { postJsonWithRetry } from "./http.js";
import type { Llm } from "./types.js";

export interface OpenAiCompatOptions {
  /** Display name used in error messages. */
  name: string;
  /** e.g. https://api.groq.com/openai/v1  (no trailing slash) */
  baseUrl: string;
  apiKey: () => string;
  model: () => string;
  fetchImpl?: typeof fetch;
  /** Extra attempts after a rate limit or server error. Default 3. */
  maxRetries?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function post(o: OpenAiCompatOptions, body: unknown) {
  return postJsonWithRetry({
    name: o.name,
    url: `${o.baseUrl}/chat/completions`,
    headers: { Authorization: `Bearer ${o.apiKey()}`, "content-type": "application/json" },
    body,
    fetchImpl: o.fetchImpl ?? fetch,
    sleep: o.sleep ?? realSleep,
    maxRetries: o.maxRetries ?? 3,
  });
}

/** Works with any provider that speaks the OpenAI chat-completions format (Gemini, Groq, OpenRouter, xAI, ...). */
export function createOpenAiCompatLlm(o: OpenAiCompatOptions): Llm {
  return {
    async complete({ system, user }) {
      const data = await post(o, {
        model: o.model(),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text) throw new Error(`${o.name} API returned no text`);
      return text;
    },
  };
}

/** Same provider settings, but with tool calling. */
export function createOpenAiCompatToolChat(o: OpenAiCompatOptions): ToolChat {
  return {
    async chat({ messages, tools }) {
      const data = await post(o, { model: o.model(), messages, tools, tool_choice: "auto" });
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error(`${o.name} API returned no message`);
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => ({
        id: String(c.id),
        type: "function" as const,
        function: { name: String(c.function?.name), arguments: String(c.function?.arguments ?? "{}") },
      }));
      return { content: typeof msg.content === "string" ? msg.content : null, toolCalls };
    },
  };
}