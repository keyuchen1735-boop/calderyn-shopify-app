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
  approveLinkedinUrl: "https://app.calderyncompany.com/social/review/abc-123?t=APPROVE_LI_TOKEN",
  approveInstagramUrl: "https://app.calderyncompany.com/social/review/abc-123?t=APPROVE_IG_TOKEN",
  rejectUrl: "https://app.calderyncompany.com/social/review/abc-123?t=REJECT_TOKEN",
};

describe("buildActionEmail", () => {
  it("subject mentions the range", () => {
    const { subject } = buildActionEmail(BASE_OPTS);
    expect(subject).toContain("June 13–19, 2026");
  });

  it("html contains the approveLinkedinUrl", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    expect(html).toContain(BASE_OPTS.approveLinkedinUrl);
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

  it("html has Approve & post to LinkedIn button label", () => {
    const { html } = buildActionEmail(BASE_OPTS);
    expect(html).toContain("Approve");
    expect(html).toContain("LinkedIn");
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

  it("html-escapes a range containing <", () => {
    const { html } = buildActionEmail({ ...BASE_OPTS, range: "June <1>–7, 2026" });
    expect(html).not.toContain("<1>");
    expect(html).toContain("&lt;1&gt;");
  });

  it("plain-text twin includes all three action URLs with labels", () => {
    const { text } = buildActionEmail(BASE_OPTS);
    expect(text).toContain(BASE_OPTS.approveLinkedinUrl);
    expect(text).toContain(BASE_OPTS.approveInstagramUrl);
    expect(text).toContain(BASE_OPTS.rejectUrl);
    // Each has a label preceding it
    expect(text).toContain("APPROVE & POST TO LINKEDIN");
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
