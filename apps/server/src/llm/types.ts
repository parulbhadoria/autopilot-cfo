export interface Llm {
  complete(args: { system: string; user: string }): Promise<string>;
}
