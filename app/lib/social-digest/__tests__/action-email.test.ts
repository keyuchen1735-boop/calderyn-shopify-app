import { describe, it, expect } from "vitest";
import { buildActionEmail } from "../run.server";

const BASE_OPTS = {
  range: "June 13–19, 2026",
  shippedCount: 3,
  waitlistDelta: 7,
  liUrls: ["https://storage.example.com/li-0.png", "https://storage.example.com/li-1.png"],
  igUrls: ["https://storage.example.com/ig-0.png", "https://storage.example.com/ig-1.png"],
  approveUrl: "https://app.calderyncompany.com/social/review/abc-123?t=APPROVE_TOKEN",
  rejectUrl: "https://app.calderyncompany.com/social/review/abc-123?t=REJECT_TOKEN",
};

describe("buildActionEmail", () => {
  it("subject mentions the range", () => {
    const { subject } = buildActionEmail(BASE_OPTS);
    expect(subject).toContain("June 13–19, 2026");
  });

  it("html contains the approveUrl", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    expect(html).toContain(BASE_OPTS.approveUrl);
  });

  it("html contains the rejectUrl", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    expect(html).toContain(BASE_OPTS.rejectUrl);
  });

  it("html contains each LinkedIn preview URL as an img src", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    for (const url of BASE_OPTS.liUrls) {
      expect(html).toContain(`src="${url}"`);
    }
  });

  it("html contains each Instagram preview URL as an img src", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    for (const url of BASE_OPTS.igUrls) {
      expect(html).toContain(`src="${url}"`);
    }
  });

  it("html has both Approve and Reject button text", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
  });

  it("html-escapes a range containing <", () => {
    const { html } = buildActionEmail({ ...BASE_OPTS, range: "June <1>–7, 2026" });
    expect(html).not.toContain("<1>");
    expect(html).toContain("&lt;1&gt;");
  });
});
