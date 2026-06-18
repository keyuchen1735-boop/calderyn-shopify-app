// app/routes/__tests__/social.review.test.ts
//
// Unit tests for the social.review.$id loader and action.
// Mocks: verifyActionToken, getSupabase, signedUrls, regenerateDigest,
//        getValidConnection, postMemberMultiImage, downloadSlide.

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  getValidConnection,
  postMemberMultiImage,
} = vi.hoisted(() => ({
  verifyActionToken: vi.fn(),
  getSupabase: vi.fn(),
  signedUrls: vi.fn(),
  downloadSlide: vi.fn(),
  regenerateDigest: vi.fn(),
  getValidConnection: vi.fn(),
  postMemberMultiImage: vi.fn(),
}));

vi.mock("~/lib/social-digest/token.server", () => ({ verifyActionToken }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase }));
vi.mock("~/lib/social-digest/store.server", () => ({ signedUrls, downloadSlide }));
vi.mock("~/lib/social-digest/run.server", () => ({ regenerateDigest }));
vi.mock("~/lib/social/linkedin-connection.server", () => ({ getValidConnection }));
vi.mock("~/lib/social/linkedin.server", () => ({ postMemberMultiImage }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Minimal valid row — override fields as needed per test. */
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
  ig_approved_at: string | null;
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
    ig_approved_at: null,
    post_results_json: null,
    ...overrides,
  };
}

type UpdateChain = {
  eq: () => UpdateChain;
  is: () => UpdateChain;
  select: () => Promise<{ error: null | { message: string }; data: { id: string }[] | null }>;
};

/**
 * Wire getSupabase for the standard happy-path shape:
 * - .select().eq().single() returns the given row
 * - both .update() calls (claim + result persist) succeed
 */
function mockRow(row: ReturnType<typeof makeRow> | null, dbError?: { message: string }) {
  const updateChain: UpdateChain = {
    eq: () => updateChain,
    is: () => updateChain,
    select: async () => ({ error: null, data: [{ id: TEST_ID }] }),
  };
  getSupabase.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: row,
            error: dbError ?? null,
          }),
        }),
      }),
      update: () => updateChain,
    }),
  });
}

/**
 * Wire getSupabase with a spy on update so tests can assert what was passed
 * to the first (claim) update.  Both updates succeed.
 */
function mockRowWithUpdateSpy(row: ReturnType<typeof makeRow>) {
  const updateChain: UpdateChain = {
    eq: () => updateChain,
    is: () => updateChain,
    select: async () => ({ error: null, data: [{ id: TEST_ID }] }),
  };
  const updateFn = vi.fn().mockReturnValue(updateChain);
  getSupabase.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: row, error: null }),
        }),
      }),
      update: updateFn,
    }),
  });
  return { updateFn };
}

/**
 * Wire getSupabase where the FIRST update (atomic claim) returns 0 rows,
 * and subsequent updates succeed. Used for "already claimed" tests.
 */
function mockRowClaimReturnsZero(row: ReturnType<typeof makeRow>) {
  let updateCallCount = 0;
  const zeroRowsChain: UpdateChain = {
    eq: () => zeroRowsChain,
    is: () => zeroRowsChain,
    select: async () => ({ error: null, data: [] }),
  };
  const successChain: UpdateChain = {
    eq: () => successChain,
    is: () => successChain,
    select: async () => ({ error: null, data: [{ id: TEST_ID }] }),
  };
  const updateFn = vi.fn().mockImplementation(() => {
    updateCallCount++;
    return updateCallCount === 1 ? zeroRowsChain : successChain;
  });
  getSupabase.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: row, error: null }),
        }),
      }),
      update: updateFn,
    }),
  });
  return { updateFn };
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

// ---------------------------------------------------------------------------
// Loader tests
// ---------------------------------------------------------------------------

describe("social.review.$id — loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedUrls.mockResolvedValue(["https://cdn.test/slide-0.png"]);
    downloadSlide.mockResolvedValue(Buffer.from("fake-png"));
    getValidConnection.mockResolvedValue(null);
    postMemberMultiImage.mockResolvedValue({ postUrn: "urn:li:share:123" });
  });

  it("returns state=invalid when verifyActionToken returns null", async () => {
    verifyActionToken.mockReturnValue(null);
    mockRow(makeRow());

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "bad-token"),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("invalid");
  });

  it("returns state=invalid when token id does not match params.id", async () => {
    verifyActionToken.mockReturnValue({ id: "different-id", action: "approve-linkedin", version: 0 });
    mockRow(makeRow());

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "mismatched"),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("invalid");
  });

  // -------------------------------------------------------------------------
  // approve-linkedin loader: li_posted_at null → confirm
  // -------------------------------------------------------------------------

  it("approve-linkedin + li_posted_at null → state=confirm with action=approve-linkedin", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve-linkedin", version: 0 });
    mockRow(makeRow({ li_posted_at: null }));
    signedUrls.mockResolvedValue(["https://cdn.test/li-0.png"]);

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "valid-token"),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("confirm");
    expect(body.action).toBe("approve-linkedin");
    expect(body.id).toBe(TEST_ID);
    expect(body.token).toBe("valid-token");
    expect(body.range).toBe("June 13–19, 2026");
    expect(body.liCaption).toBe("LinkedIn caption here.");
  });

  // -------------------------------------------------------------------------
  // approve-linkedin loader: li_posted_at set → result page
  // -------------------------------------------------------------------------

  it("approve-linkedin + li_posted_at set + linkedin posted → state=li_result with postUrn link", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve-linkedin", version: 0 });
    mockRow(makeRow({
      li_posted_at: "2026-06-18T12:00:00.000Z",
      post_results_json: { linkedin: { posted: true, postUrn: "urn:li:share:777" }, instagram: "approved (manual)" },
    }));
    signedUrls.mockResolvedValue(["https://cdn.test/li-0.png"]);

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "valid-token"),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("li_result");
    expect(body.linkedin).toEqual({ posted: true, postUrn: "urn:li:share:777" });
  });

  // -------------------------------------------------------------------------
  // approve-instagram loader: ig_approved_at null → confirm
  // -------------------------------------------------------------------------

  it("approve-instagram + ig_approved_at null → state=confirm with action=approve-instagram", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve-instagram", version: 0 });
    mockRow(makeRow({ ig_approved_at: null }));
    signedUrls.mockResolvedValue(["https://cdn.test/ig-0.png"]);

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "valid-token"),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("confirm");
    expect(body.action).toBe("approve-instagram");
    expect(body.igCaption).toBe("Instagram caption here.");
  });

  // -------------------------------------------------------------------------
  // approve-instagram loader: ig_approved_at set → assets page
  // -------------------------------------------------------------------------

  it("approve-instagram + ig_approved_at set → state=ig_assets with IG URLs + caption", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve-instagram", version: 0 });
    mockRow(makeRow({
      ig_approved_at: "2026-06-18T12:00:00.000Z",
      post_results_json: { instagram: "approved (manual)" },
    }));
    signedUrls.mockResolvedValue(["https://cdn.test/ig-0.png", "https://cdn.test/ig-1.png"]);

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "valid-token"),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("ig_assets");
    expect(body.igUrls).toEqual(["https://cdn.test/ig-0.png", "https://cdn.test/ig-1.png"]);
    expect(body.igCaption).toBe("Instagram caption here.");
  });

  it("returns state=stale when token version does not match regen_count", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve-linkedin", version: 0 });
    mockRow(makeRow({ regen_count: 2 }));

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "old-token"),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("stale");
  });

  it("returns state=invalid when DB returns an error", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve-linkedin", version: 0 });
    mockRow(null, { message: "relation does not exist" });

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "valid-token"),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("invalid");
  });

  it("returns state=invalid when row shape is malformed (li_image_paths is null)", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve-linkedin", version: 0 });
    mockRow(makeRow({ li_image_paths: null as unknown as string[] }));

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "valid-token"),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("invalid");
  });

  it("returns state=confirm for reject token + pending row", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "reject", version: 0 });
    mockRow(makeRow());

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "reject-token"),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("confirm");
    expect(body.action).toBe("reject");
  });
});

// ---------------------------------------------------------------------------
// Action — approve-linkedin
// ---------------------------------------------------------------------------

describe("social.review.$id — action (approve-linkedin)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedUrls.mockResolvedValue(["https://cdn.test/slide-0.png"]);
    downloadSlide.mockResolvedValue(Buffer.from("fake-png"));
    getValidConnection.mockResolvedValue(null);
    postMemberMultiImage.mockResolvedValue({ postUrn: "urn:li:share:123" });
  });

  // -------------------------------------------------------------------------
  // Connected → posts successfully
  // -------------------------------------------------------------------------

  it("connected: claims li_posted_at, calls postMemberMultiImage with commentary===li_caption + 4 images, returns li_posted state", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve-linkedin", version: 0 });
    getValidConnection.mockResolvedValue({
      accessToken: "tok_abc",
      memberUrn: "urn:li:person:XXXX",
    });
    const fakeBuffer = Buffer.from("png-bytes");
    downloadSlide.mockResolvedValue(fakeBuffer);
    postMemberMultiImage.mockResolvedValue({ postUrn: "urn:li:share:999" });

    const { updateFn } = mockRowWithUpdateSpy(makeRow());

    const { action } = await import("../social.review.$id");
    const res = await action({
      request: actionRequest(TEST_ID, { token: "approve-li-token" }),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;

    // postMemberMultiImage called exactly once with the right args
    expect(postMemberMultiImage).toHaveBeenCalledTimes(1);
    expect(postMemberMultiImage).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "tok_abc",
        authorUrn: "urn:li:person:XXXX",
        commentary: "LinkedIn caption here.",
        images: expect.arrayContaining([
          expect.objectContaining({ bytes: fakeBuffer, altText: "Calderyn — slide 1" }),
          expect.objectContaining({ bytes: fakeBuffer, altText: "Calderyn — slide 2" }),
          expect.objectContaining({ bytes: fakeBuffer, altText: "Calderyn — slide 3" }),
          expect.objectContaining({ bytes: fakeBuffer, altText: "Calderyn — slide 4" }),
        ]),
      }),
    );
    expect(postMemberMultiImage.mock.calls[0][0].images).toHaveLength(4);

    // Result state: posted
    expect(body.state).toBe("li_posted");
    expect(body.linkedin).toEqual({ posted: true, postUrn: "urn:li:share:999" });

    // First update: atomic claim sets li_posted_at
    expect(updateFn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ li_posted_at: expect.any(String) }),
    );
    // Second update: persists post_results_json.linkedin = posted:true
    expect(updateFn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        post_results_json: expect.objectContaining({
          linkedin: expect.objectContaining({ posted: true, postUrn: "urn:li:share:999" }),
        }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // NOT connected → li_posted_at reset to null, not-connected state, retryable
  // -------------------------------------------------------------------------

  it("NOT connected: li_posted_at reset to null, postMemberMultiImage NOT called, state=li_not_connected, retryable", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve-linkedin", version: 0 });
    getValidConnection.mockResolvedValue(null);

    const { updateFn } = mockRowWithUpdateSpy(makeRow());

    const { action } = await import("../social.review.$id");
    const res = await action({
      request: actionRequest(TEST_ID, { token: "approve-li-token" }),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;

    expect(postMemberMultiImage).not.toHaveBeenCalled();
    expect(body.state).toBe("li_not_connected");

    // li_posted_at must have been reset to null (second update resets the claim)
    const resetCall = updateFn.mock.calls.find(
      (args: unknown[]) => {
        const arg = args[0] as Record<string, unknown>;
        return arg.li_posted_at === null;
      }
    );
    expect(resetCall).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // post throws → li_posted_at reset to null, state=li_failed, no success
  // -------------------------------------------------------------------------

  it("post throws: li_posted_at reset to null, state=li_failed with error, no success", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve-linkedin", version: 0 });
    getValidConnection.mockResolvedValue({
      accessToken: "tok_abc",
      memberUrn: "urn:li:person:XXXX",
    });
    downloadSlide.mockResolvedValue(Buffer.from("png-bytes"));
    postMemberMultiImage.mockRejectedValue(new Error("LinkedIn HTTP 429 — rate limited"));

    const { updateFn } = mockRowWithUpdateSpy(makeRow());

    const { action } = await import("../social.review.$id");
    const res = await action({
      request: actionRequest(TEST_ID, { token: "approve-li-token" }),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;

    // postMemberMultiImage was attempted
    expect(postMemberMultiImage).toHaveBeenCalledTimes(1);

    // Must not claim success (Rule 12)
    expect(body.state).toBe("li_failed");
    expect(body.linkedin.posted).toBe(false);
    expect(body.linkedin.error).toContain("LinkedIn HTTP 429");

    // li_posted_at reset to null so the link still works after retry
    const resetCall = updateFn.mock.calls.find(
      (args: unknown[]) => {
        const arg = args[0] as Record<string, unknown>;
        return arg.li_posted_at === null;
      }
    );
    expect(resetCall).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Atomic claim returns 0 rows → stored result returned, postMemberMultiImage NOT called
  // -------------------------------------------------------------------------

  it("claim returns 0 rows (already claimed): returns stored li result, postMemberMultiImage NOT called", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve-linkedin", version: 0 });
    getValidConnection.mockResolvedValue({
      accessToken: "tok_abc",
      memberUrn: "urn:li:person:XXXX",
    });

    const storedResult = { posted: true, postUrn: "urn:li:share:existing" };
    mockRowClaimReturnsZero(makeRow({
      li_posted_at: "2026-06-18T11:00:00.000Z",
      post_results_json: { linkedin: storedResult },
    }));

    const { action } = await import("../social.review.$id");
    const res = await action({
      request: actionRequest(TEST_ID, { token: "approve-li-token" }),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;

    expect(postMemberMultiImage).not.toHaveBeenCalled();
    expect(body.linkedin).toEqual(storedResult);
  });

  it("returns state=invalid when token is bad on POST", async () => {
    verifyActionToken.mockReturnValue(null);

    const { action } = await import("../social.review.$id");
    const res = await action({
      request: actionRequest(TEST_ID, { token: "bad" }),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// Action — approve-instagram
// ---------------------------------------------------------------------------

describe("social.review.$id — action (approve-instagram)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedUrls.mockResolvedValue(["https://cdn.test/ig-0.png", "https://cdn.test/ig-1.png", "https://cdn.test/ig-2.png", "https://cdn.test/ig-3.png"]);
    downloadSlide.mockResolvedValue(Buffer.from("fake-png"));
    getValidConnection.mockResolvedValue(null);
    postMemberMultiImage.mockResolvedValue({ postUrn: "urn:li:share:123" });
  });

  it("claims ig_approved_at, records instagram=approved (manual), returns ig_assets state with IG URLs + caption, NO LinkedIn calls", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve-instagram", version: 0 });

    const { updateFn } = mockRowWithUpdateSpy(makeRow());

    const { action } = await import("../social.review.$id");
    const res = await action({
      request: actionRequest(TEST_ID, { token: "approve-ig-token" }),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;

    expect(body.state).toBe("ig_assets");
    expect(body.igUrls).toEqual([
      "https://cdn.test/ig-0.png",
      "https://cdn.test/ig-1.png",
      "https://cdn.test/ig-2.png",
      "https://cdn.test/ig-3.png",
    ]);
    expect(body.igCaption).toBe("Instagram caption here.");

    // LinkedIn must not be touched
    expect(postMemberMultiImage).not.toHaveBeenCalled();
    expect(getValidConnection).not.toHaveBeenCalled();

    // ig_approved_at claimed
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ ig_approved_at: expect.any(String) }),
    );
    // post_results_json.instagram recorded
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        post_results_json: expect.objectContaining({ instagram: "approved (manual)" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Action — reject
// ---------------------------------------------------------------------------

describe("social.review.$id — action (reject)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedUrls.mockResolvedValue(["https://cdn.test/slide-0.png"]);
    downloadSlide.mockResolvedValue(Buffer.from("fake-png"));
    getValidConnection.mockResolvedValue(null);
    postMemberMultiImage.mockResolvedValue({ postUrn: "urn:li:share:123" });
  });

  it("calls regenerateDigest with reasons+note and returns state=regenerated on ok", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "reject", version: 0 });
    mockRow(makeRow());
    regenerateDigest.mockResolvedValue({ ok: true, newVersion: 1 });

    const { action } = await import("../social.review.$id");
    const res = await action({
      request: actionRequest(TEST_ID, {
        token: "reject-token",
        reasons: ["Tone too salesy", "Weak visuals"],
        note: "Too much hype language.",
      }),
      params: { id: TEST_ID },
      context: {},
    });
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
    mockRow(makeRow());
    regenerateDigest.mockResolvedValue({ ok: false, capped: true });

    const { action } = await import("../social.review.$id");
    const res = await action({
      request: actionRequest(TEST_ID, {
        token: "reject-token",
        reasons: ["Captions need work"],
      }),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("capped");
  });

  it("returns state=error when regenerateDigest returns ok:false without capped", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "reject", version: 0 });
    mockRow(makeRow());
    regenerateDigest.mockResolvedValue({ ok: false, error: "render failed: chromium crash" });

    const { action } = await import("../social.review.$id");
    const res = await action({
      request: actionRequest(TEST_ID, {
        token: "reject-token",
        reasons: ["Wrong feature highlighted"],
      }),
      params: { id: TEST_ID },
      context: {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.state).toBe("error");
    expect(body.message).toContain("render failed");
  });
});
