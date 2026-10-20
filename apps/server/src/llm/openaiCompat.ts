import type { Llm } from "./types.js";

export interface OpenAiCompatOptions {
  /** Display name used in error messages. */
  name: string;
  /** e.g. https://api.groq.com/openai/v1  (no trailing slash) */
  baseUrl: string;
  apiKey: () => string;
  model: () => string;
  fetchImpl?: typeof fetch;
}

/** Works with any provider that speaks the OpenAI chat-completions format (Gemini, Groq, OpenRouter, xAI, ...). */
export function createOpenAiCompatLlm(o: OpenAiCompatOptions): Llm {
  const doFetch = o.fetchImpl ?? fetch;
  return {
    async complete({ system, user }) {
      const res = await doFetch(`${o.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${o.apiKey()}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: o.model(),
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${o.name} API error ${res.status}: ${JSON.stringify(data)}`);
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text) throw new Error(`${o.name} API returned no text`);
      return text;
    },
  };
}
