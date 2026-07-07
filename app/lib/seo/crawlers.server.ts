// Known answer-engine / AI crawler user-agents. Distinct from generic search bots (Googlebot,
// Bingbot) — those are SEO, these are AIO. Order matters: match the most specific token first.
import type { AiBotName } from "./types";
import { getSupabase } from "~/lib/supabase.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// [token as it appears in the UA (lowercased), canonical bot name]
const AI_BOTS: Array<[string, AiBotName]> = [
  ["oai-searchbot", "OAI-SearchBot"],
  ["chatgpt-user", "ChatGPT-User"],
  ["gptbot", "GPTBot"],
  ["claudebot", "ClaudeBot"],
  ["claude-user", "Claude-User"],
  ["anthropic-ai", "anthropic-ai"],
  ["perplexitybot", "PerplexityBot"],
  ["perplexity-user", "Perplexity-User"],
  ["google-extended", "Google-Extended"],
  ["ccbot", "CCBot"],
  ["amazonbot", "Amazonbot"],
  ["bytespider", "Bytespider"],
  ["cohere-ai", "cohere-ai"],
];

export function detectAiBot(userAgent: string | null): AiBotName | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  for (const [token, name] of AI_BOTS) {
    if (ua.includes(token)) return name;
  }
  return null;
}

// Fire-and-forget from storefront loaders. Never throws; skips the demo shell (non-UUID shop id).
export async function logAiCrawl(shopId: string, botName: AiBotName): Promise<void> {
  if (!UUID_RE.test(shopId)) return;
  try {
    const { error } = await getSupabase().rpc("log_ai_crawl", { p_shop_id: shopId, p_bot: botName });
    if (error) console.error(`[seo] logAiCrawl failed for shop ${shopId}:`, error.message);
  } catch (err) {
    console.error(`[seo] logAiCrawl threw for shop ${shopId}:`, err);
  }
}
