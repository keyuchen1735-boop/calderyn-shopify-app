// app/routes/__tests__/social.review.test.ts
//
// Unit tests for the social.review.$id loader and action.
// Mocks: verifyActionToken, getSupabase, signedUrls, regenerateDigest.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that resolve the mocked
// modules. vi.hoisted ensures the factories run before module evaluation.
// ---------------------------------------------------------------------------

const { verifyActionToken, getSupabase, signedUrls, regenerateDigest } = vi.hoisted(() => ({
  verifyActionToken: vi.fn(),
  getSupabase: vi.fn(),
  signedUrls: vi.fn(),
  regenerateDigest: vi.fn(),
}));

vi.mock("~/lib/social-digest/token.server", () => ({ verifyActionToken }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase }));
vi.mock("~/lib/social-digest/store.server", () => ({ signedUrls }));
vi.mock("~/lib/social-digest/run.server", () => ({ regenerateDigest }));

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
}> = {}) {
  return {
    id: TEST_ID,
    week_range: "June 13–19, 2026",
    status: "pending",
    regen_count: 0,
    consumed_at: null,
    li_image_paths: ["path/li-0.png"],
    ig_image_paths: ["path/ig-0.png"],
    li_caption: "LinkedIn caption here.",
    ig_caption: "Instagram caption here.",
    ...overrides,
  };
}

/** Wire getSupabase to return a row from .select().eq().single(). */
function mockRow(row: ReturnType<typeof makeRow> | null, dbError?: { message: string }) {
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
      update: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
    }),
  });
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
// Tests
// ---------------------------------------------------------------------------

describe("social.review.$id — loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedUrls.mockResolvedValue(["https://cdn.test/slide-0.png"]);
  });

  it("returns state=invalid when verifyActionToken returns null", async () => {
    verifyActionToken.mockReturnValue(null);
    // getSupabase should not be called — but set it up safely anyway
    mockRow(makeRow());

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "bad-token"),
      params: { id: TEST_ID },
      context: {},
    });
    const body = await res.json();
    expect(body.state).toBe("invalid");
  });

  it("returns state=invalid when token id does not match params.id", async () => {
    verifyActionToken.mockReturnValue({ id: "different-id", action: "approve", version: 0 });
    mockRow(makeRow());

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "mismatched"),
      params: { id: TEST_ID },
      context: {},
    });
    const body = await res.json();
    expect(body.state).toBe("invalid");
  });

  it("returns state=confirm with correct fields for a valid approve token + pending row at matching version", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve", version: 0 });
    mockRow(makeRow());
    signedUrls.mockResolvedValue(["https://cdn.test/slide-0.png"]);

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "valid-token"),
      params: { id: TEST_ID },
      context: {},
    });
    const body = await res.json();
    expect(body.state).toBe("confirm");
    expect(body.action).toBe("approve");
    expect(body.id).toBe(TEST_ID);
    expect(body.token).toBe("valid-token");
    expect(body.range).toBe("June 13–19, 2026");
    expect(body.liUrls).toEqual(["https://cdn.test/slide-0.png"]);
    expect(body.igUrls).toEqual(["https://cdn.test/slide-0.png"]);
    expect(body.liCaption).toBe("LinkedIn caption here.");
    expect(body.igCaption).toBe("Instagram caption here.");
    expect(body.regenCount).toBe(0);
  });

  it("returns state=confirm for a valid reject token + pending row", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "reject", version: 0 });
    mockRow(makeRow());

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "reject-token"),
      params: { id: TEST_ID },
      context: {},
    });
    const body = await res.json();
    expect(body.state).toBe("confirm");
    expect(body.action).toBe("reject");
  });

  it("returns state=stale when token version does not match regen_count", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve", version: 0 });
    mockRow(makeRow({ regen_count: 2 })); // version mismatch: token says 0, row is 2

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "old-token"),
      params: { id: TEST_ID },
      context: {},
    });
    const body = await res.json();
    expect(body.state).toBe("stale");
  });

  it("returns state=already_done when consumed_at is set", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve", version: 0 });
    mockRow(makeRow({ consumed_at: "2026-06-17T10:00:00.000Z" }));

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "used-token"),
      params: { id: TEST_ID },
      context: {},
    });
    const body = await res.json();
    expect(body.state).toBe("already_done");
  });

  it("returns state=stale when row status is not pending", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve", version: 0 });
    mockRow(makeRow({ status: "posted" }));

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "posted-token"),
      params: { id: TEST_ID },
      context: {},
    });
    const body = await res.json();
    expect(body.state).toBe("stale");
  });

  it("returns state=invalid when DB returns an error", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve", version: 0 });
    mockRow(null, { message: "relation does not exist" });

    const { loader } = await import("../social.review.$id");
    const res = await loader({
      request: loaderRequest(TEST_ID, "valid-token"),
      params: { id: TEST_ID },
      context: {},
    });
    const body = await res.json();
    expect(body.state).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------

describe("social.review.$id — action (approve)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedUrls.mockResolvedValue(["https://cdn.test/slide-0.png"]);
  });

  it("updates row (consumed_at/status/post_results) and returns state=approved", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve", version: 0 });

    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const updateFn = vi.fn().mockReturnValue({ eq: updateEq });

    getSupabase.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: makeRow(), error: null }),
          }),
        }),
        update: updateFn,
      }),
    });

    const { action } = await import("../social.review.$id");
    const res = await action({
      request: actionRequest(TEST_ID, { token: "approve-token" }),
      params: { id: TEST_ID },
      context: {},
    });
    const body = await res.json();

    expect(body.state).toBe("approved");
    expect(body.liUrls).toEqual(["https://cdn.test/slide-0.png"]);
    expect(body.igUrls).toEqual(["https://cdn.test/slide-0.png"]);
    expect(body.liCaption).toBe("LinkedIn caption here.");
    expect(body.igCaption).toBe("Instagram caption here.");

    // Verify the update was called with the right shape.
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        consumed_at: expect.any(String),
        status: "posted",
        post_results_json: {
          linkedin: "staged (no LinkedIn connection yet)",
          instagram: "manual",
        },
      }),
    );
  });

  it("returns state=invalid when token is bad on POST", async () => {
    verifyActionToken.mockReturnValue(null);

    const { action } = await import("../social.review.$id");
    const res = await action({
      request: actionRequest(TEST_ID, { token: "bad" }),
      params: { id: TEST_ID },
      context: {},
    });
    const body = await res.json();
    expect(body.state).toBe("invalid");
  });

  it("returns state=invalid when row is already consumed", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve", version: 0 });
    mockRow(makeRow({ consumed_at: "2026-06-17T10:00:00.000Z" }));

    const { action } = await import("../social.review.$id");
    const res = await action({
      request: actionRequest(TEST_ID, { token: "replay-token" }),
      params: { id: TEST_ID },
      context: {},
    });
    const body = await res.json();
    expect(body.state).toBe("invalid");
  });

  it("surfaces DB error as state=error", async () => {
    verifyActionToken.mockReturnValue({ id: TEST_ID, action: "approve", version: 0 });

    getSupabase.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: makeRow(), error: null }),
          }),
        }),
        update: () => ({
          eq: () => Promise.resolve({ error: { message: "constraint violation" } }),
        }),
      }),
    });

    const { action } = await import("../social.review.$id");
    const res = await action({
      request: actionRequest(TEST_ID, { token: "valid" }),
      params: { id: TEST_ID },
      context: {},
    });
    const body = await res.json();
    expect(body.state).toBe("error");
    expect(body.message).toContain("constraint violation");
  });
});

// ---------------------------------------------------------------------------

describe("social.review.$id — action (reject)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedUrls.mockResolvedValue(["https://cdn.test/slide-0.png"]);
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
    const body = await res.json();

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
    const body = await res.json();
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
    const body = await res.json();
    expect(body.state).toBe("error");
    expect(body.message).toContain("render failed");
  });
});
