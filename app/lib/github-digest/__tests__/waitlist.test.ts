import { describe, it, expect } from "vitest";
import { renderHtml, renderText, deriveDisplayName } from "../render.server";
import type { Activity } from "../collect.server";
import type { WaitlistSignup } from "../waitlist.server";

function emptyActivity(over: Partial<Activity> = {}): Activity {
  return {
    repo: "owner/repo",
    sinceIso: "2026-06-12T14:00:00Z",
    commits: [],
    mergedPRs: [],
    openedPRs: [],
    branchesScanned: 1,
    branchesTotal: 1,
    notes: [],
    ...over,
  };
}
function signup(over: Partial<WaitlistSignup> = {}): WaitlistSignup {
  return {
    email: "jane.doe@example.com",
    phone: null,
    referralCode: "ABC123",
    referredBy: null,
    createdAtIso: "2026-06-13T18:30:00Z",
    ...over,
  };
}
const input = (over: Record<string, unknown> = {}) => ({ dateLabel: "June 13, 2026", brand: "Calderyn", overview: "", prose: {}, ...over });

describe("renderHtml waitlist section", () => {
  it("shows a new-signups section with the derived name and email", () => {
    const html = renderHtml(emptyActivity(), [], input({ signups: [signup()] }));
    expect(html).toContain("New waitlist signups");
    expect(html).toContain("Jane Doe"); // derived from jane.doe@…
    expect(html).toContain("jane.doe@example.com");
  });
});

describe("renderText waitlist section", () => {
  it("lists new signups with name, email, and phone in the plaintext twin", () => {
    const text = renderText(
      emptyActivity(),
      [],
      input({ signups: [signup({ phone: "+1 415 555 0100" })] }),
    );
    expect(text).toContain("New waitlist signups (1)");
    expect(text).toContain("Jane Doe");
    expect(text).toContain("jane.doe@example.com");
    expect(text).toContain("+1 415 555 0100");
  });
});

describe("renderHtml waitlist details + safety", () => {
  it("includes phone and 'referred by' when present", () => {
    const html = renderHtml(
      emptyActivity(),
      [],
      input({ signups: [signup({ phone: "+1 415 555 0100", referredBy: "FRIEND7" })] }),
    );
    expect(html).toContain("+1 415 555 0100");
    expect(html).toContain("referred by FRIEND7");
  });

  it("escapes HTML in the email to prevent injection", () => {
    const html = renderHtml(
      emptyActivity(),
      [],
      input({ signups: [signup({ email: '<script>alert(1)</script>@x.com' })] }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the section entirely when there are no signups", () => {
    const html = renderHtml(emptyActivity(), [], input({ signups: [] }));
    const text = renderText(emptyActivity(), [], input({ signups: [] }));
    expect(html).not.toContain("New waitlist signups");
    expect(text).not.toContain("New waitlist signups");
  });
});

describe("deriveDisplayName", () => {
  it("humanizes a personal local-part", () => {
    expect(deriveDisplayName("jane.doe@example.com")).toBe("Jane Doe");
    expect(deriveDisplayName("john_smith@x.io")).toBe("John Smith");
    expect(deriveDisplayName("ALICE@x.io")).toBe("Alice");
    expect(deriveDisplayName("jane+calderyn@x.io")).toBe("Jane");
  });
  it("declines role mailboxes and alphanumeric noise (caller leads with email)", () => {
    expect(deriveDisplayName("info@x.io")).toBeNull();
    expect(deriveDisplayName("no-reply@x.io")).toBeNull();
    expect(deriveDisplayName("x7y2@x.io")).toBeNull();
  });
});
