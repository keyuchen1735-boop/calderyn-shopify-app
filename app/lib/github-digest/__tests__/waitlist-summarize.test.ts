import { describe, it, expect, beforeEach } from "vitest";
import { summarize } from "../summarize.server";
import type { Activity } from "../collect.server";
import type { WaitlistSignup } from "../waitlist.server";

function emptyActivity(): Activity {
  return {
    repo: "owner/repo",
    sinceIso: "2026-06-12T14:00:00Z",
    commits: [],
    mergedPRs: [],
    openedPRs: [],
    branchesScanned: 1,
    branchesTotal: 1,
    notes: [],
  };
}
function signup(): WaitlistSignup {
  return {
    email: "jane.doe@example.com",
    phone: "+15550100",
    referralCode: "ABC123",
    referredBy: null,
    createdAtIso: "2026-06-13T18:30:00Z",
  };
}

// No AI key in unit tests → deterministic template path, no network.
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("summarize with waitlist signups", () => {
  it("renders the digest (not the quiet-day card) when only new signups exist", async () => {
    const content = await summarize(emptyActivity(), { dateLabel: "June 13, 2026", signups: [signup()] });
    expect(content.mode).not.toBe("empty");
    expect(content.html).toContain("New waitlist signups");
    expect(content.html).toContain("jane.doe@example.com");
    expect(content.text).toContain("New waitlist signups");
  });

  it("still shows the quiet-day card when there is no activity and no signups", async () => {
    const content = await summarize(emptyActivity(), { dateLabel: "June 13, 2026", signups: [] });
    expect(content.mode).toBe("empty");
  });
});
