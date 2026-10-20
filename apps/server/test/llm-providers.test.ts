import { describe, expect, it } from "vitest";
import { GROQ_BASE_URL, GROQ_DEFAULT_MODEL, createLlmFromEnv, groqModel } from "../src/llm/index.js";
import { createOpenAiCompatLlm } from "../src/llm/openaiCompat.js";
import { parseMandate } from "../src/mandate/parser.js";

describe("Groq setup", () => {
  it("is disabled without GROQ_API_KEY", () => {
    expect(createLlmFromEnv({})).toBeUndefined();
  });

  it("uses the default model unless GROQ_MODEL is set", () => {
    expect(groqModel({})).toBe(GROQ_DEFAULT_MODEL);
    expect(groqModel({ GROQ_MODEL: "llama-3.3-70b-versatile" })).toBe("llama-3.3-70b-versatile");
  });

  it("calls Groq's chat-completions endpoint with the key and model, and works with the mandate parser", async () => {
    let seen: any;
    const fakeFetch = (async (url: any, init: any) => {
      seen = { url, init };
      const json = JSON.stringify({ weeklyBudget: 400, autoApproveUnder: 50, categories: ["flour", "butter"] });
      return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n" + json + "\n```" } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const llm = createOpenAiCompatLlm({
      name: "Groq",
      baseUrl: GROQ_BASE_URL,
      apiKey: () => "gsk_test",
      model: () => groqModel({}),
      fetchImpl: fakeFetch,
    });
    const { mandate } = await parseMandate("Keep flour and butter stocked, max $400/week", {
      llm,
      hardMaxWeeklyCents: 500_000,
    });
    expect(mandate.weeklyBudgetCents).toBe(40_000);
    expect(seen.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(seen.init.headers.Authorization).toBe("Bearer gsk_test");
    expect(JSON.parse(seen.init.body).model).toBe(GROQ_DEFAULT_MODEL);
  });

  it("surfaces API errors clearly", async () => {
    const f = (async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 })) as unknown as typeof fetch;
    const llm = createOpenAiCompatLlm({ name: "Groq", baseUrl: GROQ_BASE_URL, apiKey: () => "x", model: () => "m", fetchImpl: f });
    await expect(llm.complete({ system: "s", user: "u" })).rejects.toThrow(/Groq API error 401/);
  });
});
