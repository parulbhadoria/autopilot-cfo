/** Minimal OpenAI-style tool-calling types (Groq, OpenRouter, etc. all speak this format). */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; /** JSON text */ arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
}

export interface ToolChat {
  chat(args: { messages: ChatMessage[]; tools: ToolDef[] }): Promise<ChatResponse>;
}