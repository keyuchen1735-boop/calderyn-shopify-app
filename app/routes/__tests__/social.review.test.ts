// app/routes/__tests__/social.review.test.ts
//
// Unit tests for the social.review.$id loader and action.
// Mocks: verifyActionToken, getSupabase, signedUrls, regenerateDigest,
//        getValidConnectionFor, postMemberMultiImage, downloadSlide.
//
// The "approve" action is now the ONLY approval action: it posts LinkedIn to
// the owner's profile AND returns Instagram assets in every result state.
// The "approve-instagram" action is removed; "approve-linkedin" is renamed to
// "approve". The reject flow is unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { routeArgs, toResponse } from "../../lib/__tests__/_route-test-helpers";
import { LinkedInPostError } from "~/lib/social/linkedin.server";
import type * as LinkedInServer from "~/lib/social/linkedin.server";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that resolve the mocked
// modules. vi.hoisted ensures the factories run before module evaluation.
// ---------------------------------------------------------------------------

const {
  verifyActionToken,
  getSupabase,
  signedUrls,
  downloadSlide,
  regenerateDigest,
  getValidConnectionFor,
  postMemberMultiImage,
} = vi.hoisted(() => ({
  verifyActionToken: vi.fn(),
  getSupabase: vi.fn(),
  signedUrls: vi.fn(),
  downloadSlide: vi.fn(),
  regenerateDigest: vi.fn(),
  getValidConnectionFor: vi.fn(),
  postMemberMultiImage: vi.fn(),
}));

vi.mock("~/lib/social-digest/token.server", () => ({ verifyActionToken }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase }));
vi.mock("~/lib/social-digest/store.server", () => ({ signedUrls, downloadSlide }));
vi.mock("~/lib/social-digest/run.server", () => ({ regenerateDigest }));
vi.mock("~/lib/social/linkedin-connection.server", () => ({ getValidConnectionFor }));
// Keep the real LinkedInPostError class; only stub the network call.
vi.mock("~/lib/social/linkedin.server", async () => {
  const actual = await vi.importActual<typeof LinkedInServer>("~/lib/social/linkedin.server");
  return { ...actual, postMemberMultiImage };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OWNER = "alice@example.com";

/** Minimal valid digest row — override fields as needed per test. */
function makeRow(overrides: Partial<{
  id: string;
  week_range: string;
  status: string;
  regen_count: number;
  consumed_at: string | null;
  li_image_paths: string[];
  ig_image_paths: string[];
  li_caption: string;
  ig_caption: string;
  li_posted_at: string | null;
  post_results_json: Record<string, unknown> | null;
}> = {}) {
  return {
    id: TEST_ID,
    week_range: "June 13–19, 2026",
    status: "pending",
    regen_count: 0,
    consumed_at: null,
    li_image_paths: ["path/li-0.png", "path/li-1.png", "path/li-2.png", "path/li-3.png"],
    ig_image_paths: ["path/ig-0.png", "path/ig-1.png", "path/ig-2.png", "path/ig-3.png"],
    li_caption: "LinkedIn caption here.",
    ig_caption: "Instagram caption here.",
    li_posted_at: null,
    post_results_json: null,
    ...overrides,
  };
}

type LinkPostRow = { status: string; post_urn: string | null; error: string | null };

interface SupabaseMockConfig {
  /** The social_digest row returned by .select().eq().single(); or null. */
  digestRow: ReturnType<typeof makeRow> | null;
  /** DB error for the digest .single() call. */
  digestError?: { message: string };
  /** Error returned by the social_link_post INSERT (e.g. { code: "23505" }). */
  linkInsertError?: { code?: string; message?: string } | null;
  /** Row returned by the social_link_post SELECT (already-claimed read). */
  linkExistingRow?: LinkPostRow | null;
  /** Error returned by social_link_post UPDATE. */
  linkUpdateError?: { message: string } | null;
  /** Error returned by social_link_post DELETE. */
  linkDeleteError?: { message: string } | null;
}

interface SupabaseMockSpies {
  linkInsert: ReturnType<typeof vi.fn>;
  linkUpdate: ReturnType<typeof vi.fn>;
  linkDelete: ReturnType<typeof vi.fn>;
  digestUpdate: ReturnType<typeof vi.fn>;
}

/**
 * Build a getSupabase mock that branches on table name.
 * Returns spies so tests can assert insert/update/delete payloads.
 */
function mockSupabase(cfg: SupabaseMockConfig): SupabaseMockSpies {
  const linkInsert = vi.fn().mockResolvedValue({ error: cfg.linkInsertError ?? null });
  const linkUpdate = vi.fn();
  const linkDelete = vi.fn();
  const digestUpdate = vi.fn();

  // A thenable .eq() chain that resolves to the supplied terminal result.
  const eqChain = (terminal: { error: unknown } | { data: unknown; error: unknown }) => {
    const chain: Record<string, unknown> = {};
    chain.eq = () => chain;
    chain.is = () => chain;
    chain.select = async () => ("data" in terminal ? terminal : { error: terminal.error, data: [{ id: TEST_ID }] });
    chain.then = (resolve: (v: unknown) => unknown) => resolve(terminal);
    chain.single = async () => terminal;
    return chain;
  };

  getSupabase.mockReturnValue({
    from: (table: string) => {
      if (table === "social_link_post") {
        return {
          insert: linkInsert,
          select: () =>
            eqChain({ data: cfg.linkExistingRow ?? null, error: null }),
          update: (payload: unknown) => {
            linkUpdate(payload);
            return eqChain({ error: cfg.linkUpdateError ?? null });
          },
          delete: () => {
            linkDelete();
            return eqChain({ error: cfg.linkDeleteError ?? null });
          },
        };
      }
      // social_digest (and any other table)
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: cfg.digestRow,
              error: cfg.digestError ?? null,
            }),
          }),
        }),
        update: (payload: unknown) => {
          digestUpdate(payload);
          return eqChain({ error: null });
        },
      };
    },
  });

  return { linkInsert, linkUpdate, linkDelete, digestUpdate };
}

function loaderRequest(id: string, token: string): Request {
  return new Request(`https://app.test/social/review/${id}?t=${token}`);
}

function actionRequest(
  id: string,
  fields: Record<string, string | string[]>,
): Request {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      v.forEach((val) => body.append(k, val));
    } else {
      body.append(k, v);
    }
  }
  return new Request(`https://app.test/social/review/${id}`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

// Token helpers use "approve" (not "approve-linkedin")
const approveToken = () => ({ id: TEST_ID, action: "approve", version: 0, owner: OWNER });

// ---------------------------------------------------------------------------
// Loader tests
// ---------------------------------------------------------------------------

describe("social.review.$id — loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedUrls.mockResolvedValue(["https://cdn.test/slide-0.png"]);
    downloadSlide.mockResolvedValue(Buffer.from("fake-png"));
    getValidConnectionFor.mockResolvedValue(null);
    postMemberMultiImage.mockResolvedValue({ postUrn: "urn:li:share:123" });
  });

  it("returns state=invalid when verifyActionToken returns null", async () => {
    verifyActionToken.mockReturnValue(null);
    mockSupabase({ digestRow: makeRow() });

    const { loader } = await import("../social.review.$id");
    const res = toResponse(await loader(routeArgs({
      request: loaderRequest(TEST_ID, "bad-token"),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("invalid");
  });

  it("returns state=invalid when token id does not match params.id", async () => {
    verifyActionToken.mockReturnValue({ id: "different-id", action: "approve", version: 0, owner: OWNER });
    mockSupabase({ digestRow: makeRow() });

    const { loader } = await import("../social.review.$id");
    const res = toResponse(await loader(routeArgs({
      request: loaderRequest(TEST_ID, "mismatched"),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("invalid");
  });

  // -------------------------------------------------------------------------
  // approve loader: token missing owner → stale_link
  // -------------------------------------------------------------------------

  it("approve loader: token missing owner → state=stale_link", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve", version: 0 });
    mockSupabase({ digestRow: makeRow() });

    const { loader } = await import("../social.review.$id");
    const res = toResponse(await loader(routeArgs({
      request: loaderRequest(TEST_ID, "no-owner-token"),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("stale_link");
  });

  // -------------------------------------------------------------------------
  // approve loader: no social_link_post row → confirm page
  // -------------------------------------------------------------------------

  it("approve + no link_post row → state=confirm with action=approve + owner", async () => {
    verifyActionToken.mockReturnValue(approveToken());
    mockSupabase({ digestRow: makeRow(), linkExistingRow: null });
    signedUrls.mockResolvedValue(["https://cdn.test/li-0.png"]);

    const { loader } = await import("../social.review.$id");
    const res = toResponse(await loader(routeArgs({
      request: loaderRequest(TEST_ID, "valid-token"),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("confirm");
    expect(body.action).toBe("approve");
    expect(body.id).toBe(TEST_ID);
    expect(body.token).toBe("valid-token");
    expect(body.range).toBe("June 13–19, 2026");
    expect(body.liCaption).toBe("LinkedIn caption here.");
    expect(body.owner).toBe(OWNER);
  });

  // -------------------------------------------------------------------------
  // approve loader: link_post row status='posted' → li_result WITH ig assets
  // -------------------------------------------------------------------------

  it("approve + link_post posted → state=li_result with postUrn AND igUrls + igCaption", async () => {
    verifyActionToken.mockReturnValue(approveToken());
    mockSupabase({
      digestRow: makeRow(),
      linkExistingRow: { status: "posted", post_urn: "urn:li:share:777", error: null },
    });
    signedUrls.mockResolvedValue(["https://cdn.test/li-0.png", "https://cdn.test/ig-0.png"]);

    const { loader } = await import("../social.review.$id");
    const res = toResponse(await loader(routeArgs({
      request: loaderRequest(TEST_ID, "valid-token"),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("li_result");
    expect(body.linkedin).toEqual({ posted: true, postUrn: "urn:li:share:777" });
    // IG assets must be present in the loader result too
    expect(body.igUrls).toBeDefined();
    expect(body.igCaption).toBe("Instagram caption here.");
  });

  // -------------------------------------------------------------------------
  // approve loader: link_post row status='failed' → li_result (staged) WITH ig assets
  // -------------------------------------------------------------------------

  it("approve + link_post failed → state=li_result with staged warning AND igUrls + igCaption", async () => {
    verifyActionToken.mockReturnValue(approveToken());
    mockSupabase({
      digestRow: makeRow(),
      linkExistingRow: { status: "failed", post_urn: null, error: "boom" },
    });
    signedUrls.mockResolvedValue(["https://cdn.test/li-0.png"]);

    const { loader } = await import("../social.review.$id");
    const res = toResponse(await loader(routeArgs({
      request: loaderRequest(TEST_ID, "valid-token"),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("li_result");
    expect(body.linkedin.posted).toBe(false);
    expect(body.linkedin.reason).toContain("may have been created");
    expect(body.igUrls).toBeDefined();
    expect(body.igCaption).toBe("Instagram caption here.");
  });

  it("returns state=stale when token version does not match regen_count", async () => {
    verifyActionToken.mockReturnValue(approveToken());
    mockSupabase({ digestRow: makeRow({ regen_count: 2 }) });

    const { loader } = await import("../social.review.$id");
    const res = toResponse(await loader(routeArgs({
      request: loaderRequest(TEST_ID, "old-token"),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("stale");
  });

  it("returns state=invalid when DB returns an error", async () => {
    verifyActionToken.mockReturnValue(approveToken());
    mockSupabase({ digestRow: null, digestError: { message: "relation does not exist" } });

    const { loader } = await import("../social.review.$id");
    const res = toResponse(await loader(routeArgs({
      request: loaderRequest(TEST_ID, "valid-token"),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("invalid");
  });

  it("returns state=invalid when row shape is malformed (li_image_paths is null)", async () => {
    verifyActionToken.mockReturnValue(approveToken());
    mockSupabase({ digestRow: makeRow({ li_image_paths: null as unknown as string[] }) });

    const { loader } = await import("../social.review.$id");
    const res = toResponse(await loader(routeArgs({
      request: loaderRequest(TEST_ID, "valid-token"),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("invalid");
  });

  it("returns state=confirm for reject token + pending row", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "reject", version: 0 });
    mockSupabase({ digestRow: makeRow() });

    const { loader } = await import("../social.review.$id");
    const res = toResponse(await loader(routeArgs({
      request: loaderRequest(TEST_ID, "reject-token"),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("confirm");
    expect(body.action).toBe("reject");
  });
});

// ---------------------------------------------------------------------------
// Action — approve (per-founder, social_link_post claim, LinkedIn + IG assets)
// ---------------------------------------------------------------------------

describe("social.review.$id — action (approve)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedUrls.mockResolvedValue(["https://cdn.test/slide-0.png"]);
    downloadSlide.mockResolvedValue(Buffer.from("fake-png"));
    getValidConnectionFor.mockResolvedValue(null);
    postMemberMultiImage.mockResolvedValue({ postUrn: "urn:li:share:123" });
  });

  // 1. connected + claim succeeds + post succeeds → li_posted WITH ig assets
  it("connected + claim wins + post succeeds: inserts posting claim, updates posted, posts 4 images, state=li_posted WITH igUrls + igCaption", async () => {
    verifyActionToken.mockReturnValue(approveToken());
    getValidConnectionFor.mockResolvedValue({ accessToken: "tok_abc", memberUrn: "urn:li:person:XXXX" });
    const fakeBuffer = Buffer.from("png-bytes");
    downloadSlide.mockResolvedValue(fakeBuffer);
    postMemberMultiImage.mockResolvedValue({ postUrn: "urn:li:share:999" });

    signedUrls.mockResolvedValue(["https://cdn.test/ig-0.png", "https://cdn.test/ig-1.png",
      "https://cdn.test/ig-2.png", "https://cdn.test/ig-3.png"]);

    const { linkInsert, linkUpdate } = mockSupabase({ digestRow: makeRow() });

    const { action } = await import("../social.review.$id");
    const res = toResponse(await action(routeArgs({
      request: actionRequest(TEST_ID, { token: "approve-token" }),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;

    // Claim inserted with posting status for this owner
    expect(linkInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        digest_id: TEST_ID,
        owner_email: OWNER,
        platform: "linkedin",
        status: "posting",
      }),
    );
    // getValidConnectionFor called with the owner
    expect(getValidConnectionFor).toHaveBeenCalledWith(OWNER);

    // post called once with li_caption + 4 images
    expect(postMemberMultiImage).toHaveBeenCalledTimes(1);
    expect(postMemberMultiImage).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "tok_abc",
        authorUrn: "urn:li:person:XXXX",
        commentary: "LinkedIn caption here.",
        images: expect.arrayContaining([
          expect.objectContaining({ bytes: fakeBuffer, altText: "Calderyn — slide 1" }),
          expect.objectContaining({ bytes: fakeBuffer, altText: "Calderyn — slide 4" }),
        ]),
      }),
    );
    expect(postMemberMultiImage.mock.calls[0][0].images).toHaveLength(4);

    // Row updated to posted with the urn
    expect(linkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "posted", post_urn: "urn:li:share:999" }),
    );

    expect(body.state).toBe("li_posted");
    expect(body.linkedin).toEqual({ posted: true, postUrn: "urn:li:share:999" });

    // KEY: IG assets must be present in every approve result state
    expect(body.igUrls).toBeDefined();
    expect(Array.isArray(body.igUrls)).toBe(true);
    expect(body.igCaption).toBe("Instagram caption here.");
  });

  // 2. claim returns 23505, existing row posted → li_posted WITH ig assets
  it("claim 23505 + existing posted: no post, returns li_posted with existing post_urn AND igUrls + igCaption", async () => {
    verifyActionToken.mockReturnValue(approveToken());
    getValidConnectionFor.mockResolvedValue({ accessToken: "tok_abc", memberUrn: "urn:li:person:XXXX" });

    mockSupabase({
      digestRow: makeRow(),
      linkInsertError: { code: "23505" },
      linkExistingRow: { status: "posted", post_urn: "urn:li:share:existing", error: null },
    });

    const { action } = await import("../social.review.$id");
    const res = toResponse(await action(routeArgs({
      request: actionRequest(TEST_ID, { token: "approve-token" }),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;

    expect(postMemberMultiImage).not.toHaveBeenCalled();
    expect(body.state).toBe("li_posted");
    expect(body.linkedin).toEqual({ posted: true, postUrn: "urn:li:share:existing" });
    // IG assets must be present even on the already-claimed path
    expect(body.igUrls).toBeDefined();
    expect(body.igCaption).toBe("Instagram caption here.");
  });

  // 3. claim returns 23505, existing row failed → li_failed WITH ig assets
  it("claim 23505 + existing failed: no post, returns li_failed with may-have-been-created AND igUrls + igCaption", async () => {
    verifyActionToken.mockReturnValue(approveToken());
    getValidConnectionFor.mockResolvedValue({ accessToken: "tok_abc", memberUrn: "urn:li:person:XXXX" });

    mockSupabase({
      digestRow: makeRow(),
      linkInsertError: { code: "23505" },
      linkExistingRow: { status: "failed", post_urn: null, error: "earlier failure" },
    });

    const { action } = await import("../social.review.$id");
    const res = toResponse(await action(routeArgs({
      request: actionRequest(TEST_ID, { token: "approve-token" }),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;

    expect(postMemberMultiImage).not.toHaveBeenCalled();
    expect(body.state).toBe("li_failed");
    expect(body.linkedin.posted).toBe(false);
    expect(body.linkedin.error).toContain("may have been created");
    // IG assets must be present even on the failed path
    expect(body.igUrls).toBeDefined();
    expect(body.igCaption).toBe("Instagram caption here.");
  });

  // 4. claim wins but not connected → li_not_connected WITH ig assets
  it("claim wins + not connected: deletes claim row, no post, state=li_not_connected WITH igUrls + igCaption", async () => {
    verifyActionToken.mockReturnValue(approveToken());
    getValidConnectionFor.mockResolvedValue(null);

    const { linkDelete } = mockSupabase({ digestRow: makeRow() });

    const { action } = await import("../social.review.$id");
    const res = toResponse(await action(routeArgs({
      request: actionRequest(TEST_ID, { token: "approve-token" }),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;

    expect(getValidConnectionFor).toHaveBeenCalledWith(OWNER);
    expect(postMemberMultiImage).not.toHaveBeenCalled();
    expect(linkDelete).toHaveBeenCalledTimes(1);
    expect(body.state).toBe("li_not_connected");
    // IG assets must be present even when not connected
    expect(body.igUrls).toBeDefined();
    expect(body.igCaption).toBe("Instagram caption here.");
  });

  // 5. post throws LinkedInPostError phase="pre-post" → row DELETED (retryable), li_failed WITH ig assets
  it("post throws pre-post error: claim row DELETED (retryable), state=li_failed WITH igUrls + igCaption", async () => {
    verifyActionToken.mockReturnValue(approveToken());
    getValidConnectionFor.mockResolvedValue({ accessToken: "tok_abc", memberUrn: "urn:li:person:XXXX" });
    downloadSlide.mockResolvedValue(Buffer.from("png-bytes"));
    postMemberMultiImage.mockRejectedValue(new LinkedInPostError("upload init failed", "pre-post"));

    const { linkDelete, linkUpdate } = mockSupabase({ digestRow: makeRow() });

    const { action } = await import("../social.review.$id");
    const res = toResponse(await action(routeArgs({
      request: actionRequest(TEST_ID, { token: "approve-token" }),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;

    expect(postMemberMultiImage).toHaveBeenCalledTimes(1);
    expect(body.state).toBe("li_failed");
    expect(body.linkedin.posted).toBe(false);
    expect(body.linkedin.error).toContain("upload init failed");
    // pre-post is retryable → row deleted, never marked failed
    expect(linkDelete).toHaveBeenCalledTimes(1);
    expect(linkUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
    // IG assets present even on pre-post failure
    expect(body.igUrls).toBeDefined();
    expect(body.igCaption).toBe("Instagram caption here.");
  });

  // 6. post throws LinkedInPostError phase="post" → row kept as 'failed', WITH ig assets
  it("post throws post-phase error: row updated to failed (NOT deleted), state=li_failed with may-have-been-created AND igUrls + igCaption", async () => {
    verifyActionToken.mockReturnValue(approveToken());
    getValidConnectionFor.mockResolvedValue({ accessToken: "tok_abc", memberUrn: "urn:li:person:XXXX" });
    downloadSlide.mockResolvedValue(Buffer.from("png-bytes"));
    postMemberMultiImage.mockRejectedValue(new LinkedInPostError("post create 500", "post"));

    const { linkDelete, linkUpdate } = mockSupabase({ digestRow: makeRow() });

    const { action } = await import("../social.review.$id");
    const res = toResponse(await action(routeArgs({
      request: actionRequest(TEST_ID, { token: "approve-token" }),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;

    expect(postMemberMultiImage).toHaveBeenCalledTimes(1);
    expect(body.state).toBe("li_failed");
    expect(body.linkedin.posted).toBe(false);
    expect(body.linkedin.error).toContain("may have been created");
    // post-phase: keep the row, mark failed, do NOT delete
    expect(linkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
    expect(linkDelete).not.toHaveBeenCalled();
    // IG assets present even on post-phase failure
    expect(body.igUrls).toBeDefined();
    expect(body.igCaption).toBe("Instagram caption here.");
  });

  // 7. two different owners — independent claims (owner A doesn't block owner B)
  it("two owners: owner B can claim+post even when owner A already has a claim", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve", version: 0, owner: "bob@example.com" });
    getValidConnectionFor.mockResolvedValue({ accessToken: "tok_bob", memberUrn: "urn:li:person:BOB" });
    postMemberMultiImage.mockResolvedValue({ postUrn: "urn:li:share:bob" });

    const { linkInsert } = mockSupabase({ digestRow: makeRow(), linkInsertError: null });

    const { action } = await import("../social.review.$id");
    const res = toResponse(await action(routeArgs({
      request: actionRequest(TEST_ID, { token: "approve-token-bob" }),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;

    expect(linkInsert).toHaveBeenCalledWith(
      expect.objectContaining({ owner_email: "bob@example.com", status: "posting" }),
    );
    expect(getValidConnectionFor).toHaveBeenCalledWith("bob@example.com");
    expect(body.state).toBe("li_posted");
    expect(body.linkedin).toEqual({ posted: true, postUrn: "urn:li:share:bob" });
    // IG assets present for Bob too
    expect(body.igUrls).toBeDefined();
    expect(body.igCaption).toBe("Instagram caption here.");
  });

  // 8. claim insert returns non-23505 error → state=error
  it("claim insert non-unique error → state=error with the message", async () => {
    verifyActionToken.mockReturnValue(approveToken());
    mockSupabase({
      digestRow: makeRow(),
      linkInsertError: { code: "42501", message: "permission denied" },
    });

    const { action } = await import("../social.review.$id");
    const res = toResponse(await action(routeArgs({
      request: actionRequest(TEST_ID, { token: "approve-token" }),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("error");
    expect(body.message).toContain("permission denied");
  });

  it("token missing owner on POST → state=stale_link", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve", version: 0 });
    mockSupabase({ digestRow: makeRow() });

    const { action } = await import("../social.review.$id");
    const res = toResponse(await action(routeArgs({
      request: actionRequest(TEST_ID, { token: "no-owner" }),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("stale_link");
    expect(postMemberMultiImage).not.toHaveBeenCalled();
  });

  it("returns state=invalid when token is bad on POST", async () => {
    verifyActionToken.mockReturnValue(null);

    const { action } = await import("../social.review.$id");
    const res = toResponse(await action(routeArgs({
      request: actionRequest(TEST_ID, { token: "bad" }),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// Action — reject (unchanged behavior)
// ---------------------------------------------------------------------------

describe("social.review.$id — action (reject)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedUrls.mockResolvedValue(["https://cdn.test/slide-0.png"]);
    downloadSlide.mockResolvedValue(Buffer.from("fake-png"));
    getValidConnectionFor.mockResolvedValue(null);
    postMemberMultiImage.mockResolvedValue({ postUrn: "urn:li:share:123" });
  });

  it("calls regenerateDigest with reasons+note and returns state=regenerated on ok", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "reject", version: 0 });
    mockSupabase({ digestRow: makeRow() });
    regenerateDigest.mockResolvedValue({ ok: true, newVersion: 1 });

    const { action } = await import("../social.review.$id");
    const res = toResponse(await action(routeArgs({
      request: actionRequest(TEST_ID, {
        token: "reject-token",
        reasons: ["Tone too salesy", "Weak visuals"],
        note: "Too much hype language.",
      }),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;

    expect(body.state).toBe("regenerated");
    expect(regenerateDigest).toHaveBeenCalledWith(
      TEST_ID,
      expect.objectContaining({
        reasons: ["Tone too salesy", "Weak visuals"],
        note: "Too much hype language.",
      }),
    );
  });

  it("returns state=capped when regenerateDigest returns capped:true", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "reject", version: 0 });
    mockSupabase({ digestRow: makeRow() });
    regenerateDigest.mockResolvedValue({ ok: false, capped: true });

    const { action } = await import("../social.review.$id");
    const res = toResponse(await action(routeArgs({
      request: actionRequest(TEST_ID, {
        token: "reject-token",
        reasons: ["Captions need work"],
      }),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("capped");
  });

  it("returns state=error when regenerateDigest returns ok:false without capped", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "reject", version: 0 });
    mockSupabase({ digestRow: makeRow() });
    regenerateDigest.mockResolvedValue({ ok: false, error: "render failed: chromium crash" });

    const { action } = await import("../social.review.$id");
    const res = toResponse(await action(routeArgs({
      request: actionRequest(TEST_ID, {
        token: "reject-token",
        reasons: ["Wrong feature highlighted"],
      }),
      params: { id: TEST_ID },
      context: {},
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("error");
    expect(body.message).toContain("render failed");
  });
});
