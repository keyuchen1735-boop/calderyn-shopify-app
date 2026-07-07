import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcCalls: Array<{ fn: string; args: unknown }> = [];
let rpcError: { message: string } | null = null;

vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return { error: rpcError };
    },
  }),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import { detectAiBot, logAiCrawl } from "../crawlers.server";

const SHOP = "11111111-2222-3333-4444-555555555555";

beforeEach(() => { rpcCalls.length = 0; rpcError = null; });

describe("detectAiBot", () => {
  it.each([
    ["Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)", "GPTBot"],
    ["Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "ClaudeBot"],
    ["Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/bot)", "PerplexityBot"],
    ["Mozilla/5.0 (compatible; Google-Extended)", "Google-Extended"],
    ["CCBot/2.0 (https://commoncrawl.org/faq/)", "CCBot"],
  ])("classifies %s", (ua, expected) => {
    expect(detectAiBot(ua)).toBe(expected);
  });
  it("returns null for a normal browser and for Googlebot (search, not AI)", () => {
    expect(detectAiBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBeNull();
    expect(detectAiBot("Googlebot/2.1 (+http://www.google.com/bot.html)")).toBeNull();
    expect(detectAiBot(null)).toBeNull();
  });
});

describe("logAiCrawl", () => {
  it("calls the log_ai_crawl RPC for a real (UUID) shop", async () => {
    await logAiCrawl(SHOP, "GPTBot");
    expect(rpcCalls).toEqual([{ fn: "log_ai_crawl", args: { p_shop_id: SHOP, p_bot: "GPTBot" } }]);
  });
  it("skips non-UUID (demo) shops", async () => {
    await logAiCrawl("demo-shop", "GPTBot");
    expect(rpcCalls).toHaveLength(0);
  });
  it("swallows RPC errors (logs, never throws)", async () => {
    rpcError = { message: "boom" };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(logAiCrawl(SHOP, "GPTBot")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
