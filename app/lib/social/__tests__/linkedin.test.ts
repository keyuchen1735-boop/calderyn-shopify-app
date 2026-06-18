import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  fetchMemberUrn,
  postMemberMultiImage,
} from "../linkedin.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchStub(
  handler: (url: string, init?: RequestInit) => Response,
): ReturnType<typeof vi.fn> {
  return vi.fn(
    (url: string | Request | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      return Promise.resolve(handler(urlStr, init));
    },
  );
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// 1. getAuthorizeUrl
// ---------------------------------------------------------------------------

describe("getAuthorizeUrl", () => {
  it("includes response_type=code", () => {
    const url = getAuthorizeUrl({
      clientId: "cid",
      redirectUri: "https://example.com/callback",
      state: "state123",
    });
    expect(url).toContain("response_type=code");
  });

  it("includes the client_id", () => {
    const url = getAuthorizeUrl({
      clientId: "my-client-id",
      redirectUri: "https://example.com/callback",
      state: "st",
    });
    expect(url).toContain("client_id=my-client-id");
  });

  it("URL-encodes the redirect_uri", () => {
    const url = getAuthorizeUrl({
      clientId: "cid",
      redirectUri: "https://example.com/auth/callback",
      state: "st",
    });
    expect(url).toContain("redirect_uri=https%3A%2F%2Fexample.com%2Fauth%2Fcallback");
  });

  it("includes the state", () => {
    const url = getAuthorizeUrl({
      clientId: "cid",
      redirectUri: "https://example.com/callback",
      state: "my-state-value",
    });
    expect(url).toContain("state=my-state-value");
  });

  it("includes the default scope containing w_member_social", () => {
    const url = getAuthorizeUrl({
      clientId: "cid",
      redirectUri: "https://example.com/callback",
      state: "st",
    });
    // default scope is "openid profile w_member_social" — encoded, space → +or%20
    expect(url).toMatch(/scope=.*w_member_social/);
    expect(url).toContain("openid");
    expect(url).toContain("profile");
  });

  it("uses a custom scope when provided", () => {
    const url = getAuthorizeUrl({
      clientId: "cid",
      redirectUri: "https://example.com/callback",
      state: "st",
      scope: "w_member_social",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("scope")).toBe("w_member_social");
  });

  it("targets the LinkedIn authorization endpoint", () => {
    const url = getAuthorizeUrl({
      clientId: "cid",
      redirectUri: "https://example.com/callback",
      state: "st",
    });
    expect(url.startsWith("https://www.linkedin.com/oauth/v2/authorization")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. exchangeCode
// ---------------------------------------------------------------------------

describe("exchangeCode", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchStub(() =>
      jsonResponse({
        access_token: "at-abc",
        expires_in: 5183944,
        refresh_token: "rt-xyz",
        refresh_token_expires_in: 31536000,
        scope: "openid profile w_member_social",
      }),
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the LinkedIn accessToken endpoint", async () => {
    await exchangeCode({
      code: "authcode",
      redirectUri: "https://example.com/callback",
      clientId: "cid",
      clientSecret: "secret",
    });
    const stub = (globalThis.fetch as ReturnType<typeof vi.fn>);
    expect(stub).toHaveBeenCalledTimes(1);
    const [url] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
  });

  it("sends Content-Type application/x-www-form-urlencoded", async () => {
    await exchangeCode({
      code: "authcode",
      redirectUri: "https://example.com/callback",
      clientId: "cid",
      clientSecret: "secret",
    });
    const stub = (globalThis.fetch as ReturnType<typeof vi.fn>);
    const [, init] = stub.mock.calls[0] as [string, RequestInit];
    const ct = (init.headers as Record<string, string>)["Content-Type"];
    expect(ct).toBe("application/x-www-form-urlencoded");
  });

  it("sends grant_type=authorization_code with the code in the body", async () => {
    await exchangeCode({
      code: "mycode",
      redirectUri: "https://example.com/callback",
      clientId: "cid",
      clientSecret: "secret",
    });
    const stub = (globalThis.fetch as ReturnType<typeof vi.fn>);
    const [, init] = stub.mock.calls[0] as [string, RequestInit];
    const body = init.body as string;
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=mycode");
    expect(body).toContain("client_id=cid");
    expect(body).toContain("client_secret=secret");
  });

  it("maps expires_in → expiresInSec and refresh_token → refreshToken", async () => {
    const tokens = await exchangeCode({
      code: "c",
      redirectUri: "https://r",
      clientId: "ci",
      clientSecret: "cs",
    });
    expect(tokens.accessToken).toBe("at-abc");
    expect(tokens.expiresInSec).toBe(5183944);
    expect(tokens.refreshToken).toBe("rt-xyz");
    expect(tokens.refreshExpiresInSec).toBe(31536000);
    expect(tokens.scope).toBe("openid profile w_member_social");
  });

  it("throws with the status when the endpoint returns non-2xx", async () => {
    vi.stubGlobal("fetch", makeFetchStub(() =>
      new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
    ));
    await expect(
      exchangeCode({ code: "x", redirectUri: "r", clientId: "c", clientSecret: "s" }),
    ).rejects.toThrow(/401/);
  });
});

// ---------------------------------------------------------------------------
// 3. refreshAccessToken
// ---------------------------------------------------------------------------

describe("refreshAccessToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs grant_type=refresh_token with the refresh token", async () => {
    vi.stubGlobal("fetch", makeFetchStub(() =>
      jsonResponse({ access_token: "new-at", expires_in: 3600 }),
    ));
    const tokens = await refreshAccessToken({
      refreshToken: "rt-abc",
      clientId: "cid",
      clientSecret: "secret",
    });
    const stub = (globalThis.fetch as ReturnType<typeof vi.fn>);
    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    const body = init.body as string;
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=rt-abc");
    expect(body).toContain("client_id=cid");
    expect(body).toContain("client_secret=secret");
    expect(tokens.accessToken).toBe("new-at");
    expect(tokens.expiresInSec).toBe(3600);
  });

  it("throws with status when refresh returns non-2xx", async () => {
    vi.stubGlobal("fetch", makeFetchStub(() =>
      new Response("{}", { status: 400 }),
    ));
    await expect(
      refreshAccessToken({ refreshToken: "r", clientId: "c", clientSecret: "s" }),
    ).rejects.toThrow(/400/);
  });
});

// ---------------------------------------------------------------------------
// 4. fetchMemberUrn
// ---------------------------------------------------------------------------

describe("fetchMemberUrn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs /v2/userinfo with a Bearer token and returns urn:li:person:<sub>", async () => {
    vi.stubGlobal("fetch", makeFetchStub(() =>
      jsonResponse({ sub: "ABC123", name: "Test User" }),
    ));
    const urn = await fetchMemberUrn("access-token-123");
    const stub = (globalThis.fetch as ReturnType<typeof vi.fn>);
    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.linkedin.com/v2/userinfo");
    const authHeader = (init?.headers as Record<string, string>)?.["Authorization"];
    expect(authHeader).toBe("Bearer access-token-123");
    expect(urn).toBe("urn:li:person:ABC123");
  });

  it("throws when userinfo returns non-2xx", async () => {
    vi.stubGlobal("fetch", makeFetchStub(() =>
      new Response("{}", { status: 403 }),
    ));
    await expect(fetchMemberUrn("bad-token")).rejects.toThrow(/403/);
  });
});

// ---------------------------------------------------------------------------
// 5. postMemberMultiImage
// ---------------------------------------------------------------------------

describe("postMemberMultiImage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const AUTHOR_URN = "urn:li:person:AUTHOR1";
  const ACCESS_TOKEN = "tok-abc";

  function makeImages(count: number): { bytes: Buffer; altText: string }[] {
    return Array.from({ length: count }, (_, i) => ({
      bytes: Buffer.from(`image-${i}`),
      altText: `Alt text ${i}`,
    }));
  }

  function makeMultiImageFetchStub() {
    let initUploadCalls = 0;

    return makeFetchStub((url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();

      // initializeUpload calls: POST to /rest/images?action=initializeUpload
      if (url.includes("/rest/images") && url.includes("action=initializeUpload")) {
        const i = initUploadCalls++;
        return jsonResponse(
          {
            value: {
              uploadUrl: `https://upload.linkedin.com/img/upload-${i}`,
              image: `urn:li:image:IMG${i}`,
            },
          },
          200,
        );
      }

      // PUT upload calls
      if (method === "PUT" && url.includes("upload.linkedin.com")) {
        return new Response(null, { status: 201 });
      }

      // POST /rest/posts
      if (url.includes("/rest/posts") && method === "POST") {
        const headers = new Headers({
          "x-restli-id": "urn:li:share:POST999",
        });
        return new Response(null, { status: 201, headers });
      }

      return new Response("unexpected call", { status: 500 });
    });
  }

  it("calls initializeUpload 4× and PUT 4× and POSTs /rest/posts once for 4 images", async () => {
    const stub = makeMultiImageFetchStub();
    vi.stubGlobal("fetch", stub);

    await postMemberMultiImage({
      accessToken: ACCESS_TOKEN,
      authorUrn: AUTHOR_URN,
      commentary: "My weekly carousel",
      images: makeImages(4),
    });

    const calls = stub.mock.calls as [string, RequestInit][];
    const initCalls = calls.filter(
      ([url]) => url.includes("/rest/images") && url.includes("action=initializeUpload"),
    );
    const putCalls = calls.filter(
      ([url, init]) =>
        (init?.method ?? "GET").toUpperCase() === "PUT" && url.includes("upload.linkedin.com"),
    );
    const postsCalls = calls.filter(
      ([url, init]) =>
        url.includes("/rest/posts") && (init?.method ?? "GET").toUpperCase() === "POST",
    );

    expect(initCalls).toHaveLength(4);
    expect(putCalls).toHaveLength(4);
    expect(postsCalls).toHaveLength(1);
  });

  it("the /rest/posts body has 4 images with correct id and altText, and the commentary", async () => {
    vi.stubGlobal("fetch", makeMultiImageFetchStub());

    const images = makeImages(4);
    await postMemberMultiImage({
      accessToken: ACCESS_TOKEN,
      authorUrn: AUTHOR_URN,
      commentary: "Weekly digest carousel",
      images,
    });

    const stub = (globalThis.fetch as ReturnType<typeof vi.fn>);
    const calls = stub.mock.calls as [string, RequestInit][];
    const [, postsInit] = calls.find(
      ([url, init]) =>
        url.includes("/rest/posts") && (init?.method ?? "GET").toUpperCase() === "POST",
    )!;
    const body = JSON.parse(postsInit.body as string) as Record<string, unknown>;

    expect(body["commentary"]).toBe("Weekly digest carousel");
    expect(body["author"]).toBe(AUTHOR_URN);
    expect(body["visibility"]).toBe("PUBLIC");

    const multiImage = (body["content"] as Record<string, unknown>)["multiImage"] as {
      images: { id: string; altText: string }[];
    };
    expect(multiImage.images).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(multiImage.images[i].id).toBe(`urn:li:image:IMG${i}`);
      expect(multiImage.images[i].altText).toBe(`Alt text ${i}`);
    }
  });

  it("returns the postUrn from the x-restli-id response header", async () => {
    vi.stubGlobal("fetch", makeMultiImageFetchStub());

    const result = await postMemberMultiImage({
      accessToken: ACCESS_TOKEN,
      authorUrn: AUTHOR_URN,
      commentary: "Test",
      images: makeImages(4),
    });

    expect(result.postUrn).toBe("urn:li:share:POST999");
  });

  it("sends required LinkedIn headers on initializeUpload calls", async () => {
    vi.stubGlobal("fetch", makeMultiImageFetchStub());

    await postMemberMultiImage({
      accessToken: ACCESS_TOKEN,
      authorUrn: AUTHOR_URN,
      commentary: "Test",
      images: makeImages(4),
    });

    const stub = (globalThis.fetch as ReturnType<typeof vi.fn>);
    const calls = stub.mock.calls as [string, RequestInit][];
    const [, initUploadInit] = calls.find(
      ([url]) => url.includes("/rest/images") && url.includes("action=initializeUpload"),
    )!;
    const headers = initUploadInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers["LinkedIn-Version"]).toBe("202506");
    expect(headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
  });

  it("sends the initializeUpload body with the authorUrn as owner", async () => {
    vi.stubGlobal("fetch", makeMultiImageFetchStub());

    await postMemberMultiImage({
      accessToken: ACCESS_TOKEN,
      authorUrn: AUTHOR_URN,
      commentary: "Test",
      images: makeImages(4),
    });

    const stub = (globalThis.fetch as ReturnType<typeof vi.fn>);
    const calls = stub.mock.calls as [string, RequestInit][];
    const [, initUploadInit] = calls.find(
      ([url]) => url.includes("/rest/images") && url.includes("action=initializeUpload"),
    )!;
    const body = JSON.parse(initUploadInit.body as string) as Record<string, unknown>;
    const req = body["initializeUploadRequest"] as Record<string, string>;
    expect(req["owner"]).toBe(AUTHOR_URN);
  });

  it("throws with status when initializeUpload returns non-2xx", async () => {
    vi.stubGlobal("fetch", makeFetchStub(() =>
      new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }),
    ));

    await expect(
      postMemberMultiImage({
        accessToken: "bad",
        authorUrn: AUTHOR_URN,
        commentary: "Test",
        images: makeImages(4),
      }),
    ).rejects.toThrow(/401/);
  });

  it("throws with status when /rest/posts returns non-2xx", async () => {
    let initCalls = 0;
    vi.stubGlobal("fetch", makeFetchStub((url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/rest/images") && url.includes("action=initializeUpload")) {
        const i = initCalls++;
        return jsonResponse({
          value: { uploadUrl: `https://upload.linkedin.com/img/u${i}`, image: `urn:li:image:I${i}` },
        });
      }
      if (method === "PUT") return new Response(null, { status: 201 });
      // /rest/posts fails
      return new Response(JSON.stringify({ message: "Bad Request" }), { status: 400 });
    }));

    await expect(
      postMemberMultiImage({
        accessToken: ACCESS_TOKEN,
        authorUrn: AUTHOR_URN,
        commentary: "Test",
        images: makeImages(4),
      }),
    ).rejects.toThrow(/400/);
  });

  it("throws a clear error when images.length === 1 (below minimum of 2)", async () => {
    vi.stubGlobal("fetch", makeFetchStub(() => new Response(null, { status: 200 })));

    await expect(
      postMemberMultiImage({
        accessToken: ACCESS_TOKEN,
        authorUrn: AUTHOR_URN,
        commentary: "Test",
        images: makeImages(1),
      }),
    ).rejects.toThrow(/2.{0,10}20/);
  });

  it("throws a clear error when images.length === 0 (below minimum)", async () => {
    await expect(
      postMemberMultiImage({
        accessToken: ACCESS_TOKEN,
        authorUrn: AUTHOR_URN,
        commentary: "Test",
        images: [],
      }),
    ).rejects.toThrow(/2.{0,10}20/);
  });

  it("throws a clear error when images.length === 21 (above maximum of 20)", async () => {
    await expect(
      postMemberMultiImage({
        accessToken: ACCESS_TOKEN,
        authorUrn: AUTHOR_URN,
        commentary: "Test",
        images: makeImages(21),
      }),
    ).rejects.toThrow(/2.{0,10}20/);
  });
});
