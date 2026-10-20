import { config } from "../config.js";
import { createLlmFromEnv } from "../llm/index.js";
import { parseMandate } from "../mandate/parser.js";

const text =
  process.argv.slice(2).join(" ") ||
  "Keep flour and butter stocked, max $400/week, auto-approve under $50, ask me for the rest.";

const llm = createLlmFromEnv();
if (!llm) {
  console.error("GROQ_API_KEY is not set in .env (get a free key at console.groq.com).");
  process.exit(1);
}

try {
  const { mandate, assumptions } = await parseMandate(text, {
    llm,
    hardMaxWeeklyCents: config.hardMaxWeeklyCents(),
  });
  console.log("Input:", text, "\n");
  console.log(JSON.stringify(mandate, null, 2));
  console.log("\nAssumptions the owner should confirm:", assumptions);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
