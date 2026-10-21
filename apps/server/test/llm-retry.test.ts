import { describe, expect, it } from "vitest";
import { parseWaitMs } from "../src/llm/http.js";
import { createOpenAiCompatLlm, createOpenAiCompatToolChat } from "../src/llm/openaiCompat.js";

const rateLimited = (msg: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message: msg } }), { status: 429, headers });
const ok = (content = "pong") => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

function fakeFetch(responses: Response[]) {
  let i = 0;
  const calls: number[] = [];
  const f = (async () => {
    calls.push(i);
    return responses[Math.min(i++, responses.length - 1)].clone();
  }) as unknown as typeof fetch;
  return { f, calls };
}

const make = (f: typeof fetch, sleeps: number[], extra = {}) =>
  createOpenAiCompatLlm({ name: "Groq", baseUrl: "https://x.test/v1", apiKey: () => "k", model: () => "m", fetchImpl: f, sleep: async (ms) => void sleeps.push(ms), ...extra });

describe("parseWaitMs", () => {
  const h = (v?: string) => new Headers(v ? { "retry-after": v } : {});
  it("reads the Retry-After header in seconds", () => expect(parseWaitMs(h("3"), {})).toBe(3_000));
  it("reads 'try again in 2.04s' from Groq's message", () => {
    expect(parseWaitMs(h(), { error: { message: "Rate limit. Please try again in 2.04s. Need more tokens?" } })).toBeCloseTo(2_040);
  });
  it("reads minute and millisecond forms", () => {
    expect(parseWaitMs(h(), { error: { message: "Please try again in 7m12.5s." } })).toBeCloseTo(432_500);
    expect(parseWaitMs(h(), { error: { message: "try again in 350ms" } })).toBe(350);
  });
  it("returns undefined when nothing tells us", () => {
    expect(parseWaitMs(h(), { error: { message: "nope" } })).toBeUndefined();
    expect(parseWaitMs(h(), {})).toBeUndefined();
  });
});

describe("retry on rate limits", () => {
  it("waits as long as the provider asks, then succeeds", async () => {
    const { f, calls } = fakeFetch([rateLimited("Rate limit reached. Please try again in 2.04s."), ok("hello")]);
    const sleeps: number[] = [];
    const out = await make(f, sleeps).complete({ system: "s", user: "u" });
    expect(out).toBe("hello");
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2_040);
    expect(sleeps[0]).toBeLessThan(3_000);
  });

  it("works for the tool-calling chat too", async () => {
    const { f } = fakeFetch([rateLimited("try again in 1s"), new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "1", function: { name: "walk_away", arguments: "{}" } }] } }] }), { status: 200 })]);
    const sleeps: number[] = [];
    const chat = createOpenAiCompatToolChat({ name: "Groq", baseUrl: "https://x.test/v1", apiKey: () => "k", model: () => "m", fetchImpl: f, sleep: async (ms) => void sleeps.push(ms) });
    const r = await chat.chat({ messages: [], tools: [] });
    expect(r.toolCalls[0].function.name).toBe("walk_away");
    expect(sleeps).toHaveLength(1);
  });

  it("retries server errors with a default wait", async () => {
    const { f } = fakeFetch([new Response("{}", { status: 503 }), ok()]);
    const sleeps: number[] = [];
    expect(await make(f, sleeps).complete({ system: "s", user: "u" })).toBe("pong");
    expect(sleeps).toEqual([2_250]);
  });

  it("gives up after maxRetries and reports the error", async () => {
    const { f, calls } = fakeFetch([rateLimited("try again in 1s")]);
    const sleeps: number[] = [];
    await expect(make(f, sleeps, { maxRetries: 2 }).complete({ system: "s", user: "u" })).rejects.toThrow(/Groq API error 429/);
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it("does not wait out long limits such as a daily quota", async () => {
    const { f, calls } = fakeFetch([rateLimited("Daily limit reached. Please try again in 7m12s.")]);
    const sleeps: number[] = [];
    await expect(make(f, sleeps).complete({ system: "s", user: "u" })).rejects.toThrow(/429/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it("does not retry client errors like 400 or 401", async () => {
    for (const status of [400, 401, 404]) {
      const { f, calls } = fakeFetch([new Response(JSON.stringify({ error: { message: "bad" } }), { status })]);
      const sleeps: number[] = [];
      await expect(make(f, sleeps).complete({ system: "s", user: "u" })).rejects.toThrow(new RegExp(String(status)));
      expect(calls).toHaveLength(1);
    }
  });
});