import Anthropic from "@anthropic-ai/sdk";
import { recordUsage } from "./cache-usage.server";

// Verified against the live Anthropic API at build time (spec §10.1).
export const DEFAULT_ASSISTANT_MODEL = "claude-sonnet-4-6";

let _client: Anthropic | null = null;

/**
 * Wrap messages.create so every non-streaming response reports its token usage
 * to the central cache tally — one place to measure prompt-cache impact across
 * all surfaces, with no edits at the call sites.
 */
function instrumentUsage(client: Anthropic): Anthropic {
  const original = client.messages.create.bind(client.messages);
  client.messages.create = ((...args: Parameters<typeof original>) => {
    const result = original(...args);
    // Non-streaming create returns a thenable (APIPromise<Message>); streaming
    // returns an async-iterable Stream with no usage to read here.
    const thenable = result as { then?: unknown };
    if (typeof thenable.then === "function") {
      return (result as Promise<Anthropic.Message>).then((res) => {
        recordUsage(res?.usage);
        if (process.env.CACHE_USAGE_LOG === "1") {
          const u = res?.usage;
          // Per-call cache visibility (opt-in). If cacheRead stays 0 across
          // repeated calls with a stable prefix, a silent invalidator is at work.
          console.debug("[cache-usage]", {
            uncachedIn: u?.input_tokens ?? 0,
            cacheRead: u?.cache_read_input_tokens ?? 0,
            cacheWrite: u?.cache_creation_input_tokens ?? 0,
            out: u?.output_tokens ?? 0,
          });
        }
        return res;
      });
    }
    return result;
  }) as typeof client.messages.create;
  return client;
}

export function getAnthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  _client = instrumentUsage(new Anthropic({ apiKey }));
  return _client;
}

/** Model string is env-driven; no literal model id elsewhere in the codebase. */
export function assistantModel(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_ASSISTANT_MODEL;
}

// Haiku by default for the digest crons: the github/social summaries are simple
// and low-volume, so the cheaper model (~3x less than Sonnet) is the right
// tradeoff, and both digests fall back to deterministic templates if Claude
// fails. Override with DIGEST_MODEL.
export const DEFAULT_DIGEST_MODEL = "claude-haiku-4-5";

/** Model for the digest crons; env-overridable via DIGEST_MODEL. */
export function digestModel(): string {
  return process.env.DIGEST_MODEL || DEFAULT_DIGEST_MODEL;
}

/** Model for the new-product listing drafts: structured extraction against a
 *  forced tool schema, so the digest-class model is the right default. The
 *  deterministic parser handles common intents before this is ever called.
 *  Override with LISTING_DRAFT_MODEL. */
export function listingDraftModel(): string {
  return process.env.LISTING_DRAFT_MODEL || DEFAULT_DIGEST_MODEL;
}

/** Model for Radar's overnight move drafting and apply-time section copy:
 *  short structured rewrites over deterministic templates, so the digest-class
 *  model is the right default. Override with RADAR_DRAFT_MODEL. */
export function radarDraftModel(): string {
  return process.env.RADAR_DRAFT_MODEL || DEFAULT_DIGEST_MODEL;
}
