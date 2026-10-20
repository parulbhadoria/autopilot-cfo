// Checks your Groq key works and lists the model ids it can use.
import "../config.js"; // loads .env
import { GROQ_BASE_URL, createLlmFromEnv, groqModel } from "../llm/index.js";

const llm = createLlmFromEnv();
if (!llm) {
  console.error("GROQ_API_KEY is not set in .env (get a free key at console.groq.com).");
  process.exit(1);
}
console.log("Provider: Groq   model:", groqModel());

try {
  const res = await fetch(`${GROQ_BASE_URL}/models`, { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } });
  const data: any = await res.json().catch(() => ({}));
  if (res.ok) console.log("Models your key can use:", (data.data ?? []).map((m: any) => m.id).join(", "));
  else console.log("Could not list models:", res.status, JSON.stringify(data).slice(0, 300));

  const out = await llm.complete({ system: "Reply with exactly: pong", user: "ping" });
  console.log("LLM replied:", out.trim().slice(0, 100));
} catch (e) {
  console.error((e as Error).message);
  console.error("If the model is unavailable, set GROQ_MODEL in .env to one of the ids listed above.");
  process.exit(1);
}
