import { describe, it, expect, vi, beforeEach } from "vitest";

// Spies live in vi.hoisted so the vi.mock factories can close over them.
const { consumeOAuthStateMock, exchangeAndStoreMock } = vi.hoisted(() => ({
  consumeOAuthStateMock: vi.fn(),
  exchangeAndStoreMock: vi.fn(),
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({}) }));
vi.mock("~/lib/meta/oauth-state.server", () => ({ consumeOAuthState: consumeOAuthStateMock }));
vi.mock("~/lib/seo/google-search-console.server", () => ({ exchangeAndStore: exchangeAndStoreMock }));
vi.mock("~/lib/dashboard/http.server", () => ({ publicBaseUrl: () => "https://app.calderyncompany.com" }));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import { loader } from "../dashboard.auth.gsc_.callback";

function req(qs: string) {
  return { request: new Request(`https://app.calderyncompany.com/dashboard/auth/gsc/callback${qs}`) } as never;
}

beforeEach(() => vi.clearAllMocks());

describe("gsc oauth callback", () => {
  it("lands on the Search screen with ?search=connected after a successful exchange", async () => {
    consumeOAuthStateMock.mockResolvedValue("shop-1");
    exchangeAndStoreMock.mockResolvedValue(undefined);
    const res = (await loader(req("?code=abc&state=xyz"))) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.calderyncompany.com/dashboard/search?search=connected");
    expect(exchangeAndStoreMock).toHaveBeenCalledWith("shop-1", "abc");
  });
  it("redirects to the Search screen with ?search=error when params are missing", async () => {
    const res = (await loader(req(""))) as Response;
    expect(res.headers.get("location")).toBe("https://app.calderyncompany.com/dashboard/search?search=error&reason=missing_params");
  });
  it("redirects to the Search screen with reason=bad_state on an invalid nonce", async () => {
    consumeOAuthStateMock.mockRejectedValue(new Error("nonce spent"));
    const res = (await loader(req("?code=abc&state=xyz"))) as Response;
    expect(res.headers.get("location")).toBe("https://app.calderyncompany.com/dashboard/search?search=error&reason=bad_state");
  });
  it("redirects to the Search screen with reason=exchange_failed when the token exchange throws", async () => {
    consumeOAuthStateMock.mockResolvedValue("shop-1");
    exchangeAndStoreMock.mockRejectedValue(new Error("google down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = (await loader(req("?code=abc&state=xyz"))) as Response;
    expect(res.headers.get("location")).toBe("https://app.calderyncompany.com/dashboard/search?search=error&reason=exchange_failed");
    spy.mockRestore();
  });
});
