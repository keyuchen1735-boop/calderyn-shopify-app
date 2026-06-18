import { describe, it, expect } from "vitest";
import { buildActionEmail } from "../run.server";

const BASE_OPTS = {
  range: "June 13–19, 2026",
  shippedCount: 3,
  waitlistDelta: 7,
  liUrls: ["https://storage.example.com/li-0.png", "https://storage.example.com/li-1.png"],
  igUrls: ["https://storage.example.com/ig-0.png", "https://storage.example.com/ig-1.png"],
  liCaption: "Default LinkedIn caption.",
  igCaption: "Default Instagram caption.",
  linkedinApprovals: [
    { label: "alice@example.com", url: "https://app.calderyncompany.com/social/review/abc-123?t=APPROVE_LI_TOKEN_ALICE" },
    { label: "bob@example.com", url: "https://app.calderyncompany.com/social/review/abc-123?t=APPROVE_LI_TOKEN_BOB" },
  ],
  approveInstagramUrl: "https://app.calderyncompany.com/social/review/abc-123?t=APPROVE_IG_TOKEN",
  rejectUrl: "https://app.calderyncompany.com/social/review/abc-123?t=REJECT_TOKEN",
};

describe("buildActionEmail", () => {
  it("subject mentions the range", () => {
    const { subject } = buildActionEmail(BASE_OPTS);
    expect(subject).toContain("June 13–19, 2026");
  });

  it("html contains every LinkedIn approval URL", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    for (const approval of BASE_OPTS.linkedinApprovals) {
      expect(html).toContain(approval.url);
    }
  });

  it("html has a per-founder labelled button for each approval", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    expect(html).toContain("Post to LinkedIn — alice@example.com");
    expect(html).toContain("Post to LinkedIn — bob@example.com");
  });

  it("html contains the approveInstagramUrl", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    expect(html).toContain(BASE_OPTS.approveInstagramUrl);
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

  it("html has LinkedIn platform heading", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    expect(html).toContain("LinkedIn");
  });

  it("html has Instagram platform heading", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    expect(html).toContain("Instagram");
  });

  it("html has per-founder Post to LinkedIn button labels", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    expect(html).toContain("Post to LinkedIn — alice@example.com");
    expect(html).toContain("Post to LinkedIn — bob@example.com");
  });

  it("html has Approve Instagram button label", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    expect(html).toContain("Approve");
    expect(html).toContain("Instagram");
  });

  it("html has Reject & regenerate both button label", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    expect(html).toContain("Reject");
  });

  it("single approval entry renders exactly one LinkedIn button", () => {
    const { html } = buildActionEmail({
      ...BASE_OPTS,
      linkedinApprovals: [
        { label: "solo@example.com", url: "https://app.calderyncompany.com/social/review/abc-123?t=SOLO" },
      ],
    });
    expect(html).toContain("Post to LinkedIn — solo@example.com");
    expect(html).toContain("https://app.calderyncompany.com/social/review/abc-123?t=SOLO");
    // No leftover labels from BASE_OPTS
    expect(html).not.toContain("alice@example.com");
    expect(html).not.toContain("bob@example.com");
    // Exactly one per-founder LinkedIn button
    expect(html.match(/Post to LinkedIn —/g)?.length).toBe(1);
  });

  it("html-escapes a range containing <", () => {
    const { html } = buildActionEmail({ ...BASE_OPTS, range: "June <1>–7, 2026" });
    expect(html).not.toContain("<1>");
    expect(html).toContain("&lt;1&gt;");
  });

  it("plain-text twin includes every LinkedIn approval URL with its founder label", () => {
    const { text } = buildActionEmail(BASE_OPTS);
    for (const approval of BASE_OPTS.linkedinApprovals) {
      expect(text).toContain(approval.url);
      expect(text).toContain(approval.label);
    }
  });

  it("plain-text twin includes Instagram + reject action URLs with labels", () => {
    const { text } = buildActionEmail(BASE_OPTS);
    expect(text).toContain(BASE_OPTS.approveInstagramUrl);
    expect(text).toContain(BASE_OPTS.rejectUrl);
    expect(text).toContain("APPROVE INSTAGRAM");
    expect(text).toContain("REJECT & REGENERATE");
  });

  it("includes the LinkedIn and Instagram captions (post descriptions) in html and text", () => {
    const { html, text } = buildActionEmail({
      ...BASE_OPTS,
      liCaption: "We shipped 50 things this week. Here's the one that matters. #Shopify",
      igCaption: "Is your store actually doing well? 🛠️ #Ecommerce",
    });
    expect(html).toContain("We shipped 50 things this week. Here");
    expect(html).toContain("Is your store actually doing well? 🛠️ #Ecommerce");
    expect(text).toContain("We shipped 50 things this week. Here's the one that matters. #Shopify");
    expect(text).toContain("Is your store actually doing well? 🛠️ #Ecommerce");
  });

  it("html-escapes captions (no raw injection)", () => {
    const { html } = buildActionEmail({
      ...BASE_OPTS,
      liCaption: "<script>alert(1)</script>",
      igCaption: "x",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
