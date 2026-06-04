import Anthropic from "@anthropic-ai/sdk";

// Verified against the live Anthropic API at build time (spec §10.1).
export const DEFAULT_ASSISTANT_MODEL = "claude-sonnet-4-6";

let _client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Model string is env-driven; no literal model id elsewhere in the codebase. */
export function assistantModel(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_ASSISTANT_MODEL;
}
