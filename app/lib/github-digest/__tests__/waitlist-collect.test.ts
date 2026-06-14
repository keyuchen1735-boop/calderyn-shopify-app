import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildChain,
  setSupabaseResponse,
  resetRecorded,
  getRecorded,
} from "../../__tests__/_supabase_chain_mock";

let shouldThrow = false;
vi.mock("../../supabase.server", () => ({
  getSupabase: () => {
    if (shouldThrow) throw new Error("Supabase is not configured");
    return buildChain();
  },
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the supabase fake is registered before the module under test loads
import { collectWaitlistSignups } from "../waitlist.server";

const SINCE = Date.parse("2026-06-12T14:00:00Z");

beforeEach(() => {
  shouldThrow = false;
  resetRecorded();
});

describe("collectWaitlistSignups", () => {
  it("maps rows to signups (camelCase, nulls preserved) and scopes to the window", async () => {
    setSupabaseResponse({
      data: [
        { email: "a@x.io", phone: "+15550001", referral_code: "AAA111", referred_by: null, created_at: "2026-06-13T20:00:00Z" },
        { email: "b@x.io", phone: null, referral_code: "BBB222", referred_by: "AAA111", created_at: "2026-06-13T10:00:00Z" },
      ],
      error: null,
    });

    const res = await collectWaitlistSignups({ sinceMs: SINCE });

    expect(res.note).toBeNull();
    expect(res.signups).toEqual([
      { email: "a@x.io", phone: "+15550001", referralCode: "AAA111", referredBy: null, createdAtIso: "2026-06-13T20:00:00Z" },
      { email: "b@x.io", phone: null, referralCode: "BBB222", referredBy: "AAA111", createdAtIso: "2026-06-13T10:00:00Z" },
    ]);
    // read from the waitlist table, filtered to the trailing window, newest first
    expect(getRecorded("from")).toContainEqual(["waitlist"]);
    expect(getRecorded("gte")).toContainEqual(["created_at", new Date(SINCE).toISOString()]);
    expect(getRecorded("order")).toContainEqual(["created_at", { ascending: false }]);
  });

  it("surfaces a note and no rows when the query errors — never throws", async () => {
    setSupabaseResponse({ data: null, error: { message: "boom" } });
    const res = await collectWaitlistSignups({ sinceMs: SINCE });
    expect(res.signups).toEqual([]);
    expect(res.note).toMatch(/Waitlist signups unavailable/);
    expect(res.note).toContain("boom");
  });

  it("surfaces a note when Supabase is not configured — never throws", async () => {
    shouldThrow = true;
    const res = await collectWaitlistSignups({ sinceMs: SINCE });
    expect(res.signups).toEqual([]);
    expect(res.note).toMatch(/Waitlist signups unavailable/);
  });
});
