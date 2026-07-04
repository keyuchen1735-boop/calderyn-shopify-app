import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rateLimit, clientIpKey } from "../rate-limit.server";

// Minimal Supabase stub: the limiter only ever calls .rpc(). The window-bucket
// math lives in SQL (rate_limit_touch); here we drive the count it returns and
// assert how rateLimit interprets it.
function clientReturning(
  rpc: () => { data: unknown; error: unknown },
): SupabaseClient {
  return { rpc: vi.fn(rpc) } as unknown as SupabaseClient;
}

describe("rateLimit (Postgres-backed)", () => {
  it("allows while the returned count is within the limit, then blocks", async () => {
    let n = 0;
    const sb = clientReturning(() => ({ data: ++n, error: null }));
    // limit 3 → counts 1,2,3 allowed; the 4th (count 4) is blocked.
    expect(await rateLimit("k", 3, 60_000, sb)).toBe(true);
    expect(await rateLimit("k", 3, 60_000, sb)).toBe(true);
    expect(await rateLimit("k", 3, 60_000, sb)).toBe(true);
    expect(await rateLimit("k", 3, 60_000, sb)).toBe(false);
  });

  it("converts windowMs to whole seconds for the RPC", async () => {
    const sb = clientReturning(() => ({ data: 1, error: null }));
    await rateLimit("k", 10, 90_000, sb);
    expect(sb.rpc).toHaveBeenCalledWith("rate_limit_touch", {
      p_bucket: "k",
      p_window_seconds: 90,
    });
  });

  it("fails OPEN (and logs) when the limiter RPC returns an error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sb = clientReturning(() => ({ data: null, error: { message: "boom" } }));
    expect(await rateLimit("k", 1, 60_000, sb)).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("fails OPEN when the client throws (e.g. Supabase not configured)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sb = {
      rpc: () => {
        throw new Error("not configured");
      },
    } as unknown as SupabaseClient;
    expect(await rateLimit("k", 1, 60_000, sb)).toBe(true);
    spy.mockRestore();
  });
});

describe("clientIpKey", () => {
  it("prefers x-real-ip (the platform-set connection IP) over x-forwarded-for", () => {
    const req = new Request("https://x/y", {
      headers: {
        "x-real-ip": "5.6.7.8",
        "x-forwarded-for": "1.2.3.4, 5.6.7.8",
      },
    });
    expect(clientIpKey(req, "login")).toBe("login:5.6.7.8");
  });

  it("uses the rightmost (proxy-added) x-forwarded-for hop, not the spoofable leftmost", () => {
    // A client can prepend a fake hop; the platform appends the real IP, so the
    // trustworthy value is the last one.
    const req = new Request("https://x/y", {
      headers: { "x-forwarded-for": "9.9.9.9, 5.6.7.8" },
    });
    expect(clientIpKey(req, "login")).toBe("login:5.6.7.8");
  });

  it("falls back to 'unknown' when no IP header is present", () => {
    expect(clientIpKey(new Request("https://x/y"), "login")).toBe("login:unknown");
  });
});
