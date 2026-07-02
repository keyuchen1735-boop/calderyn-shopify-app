import { describe, it, expect, beforeEach, vi } from "vitest";
import { routeArgs } from "../../lib/__tests__/_route-test-helpers";

const sendEmail = vi.fn();
vi.mock("~/lib/email/send.server", () => ({ sendEmail }));

const goodEmails = [
  { to: "john@calderyncompany.com", subject: "Your post", text: "post one" },
  { to: "kennethlee@calderyncompany.com", subject: "Your post", text: "post two" },
];

const POST = (body: unknown, auth = "Bearer s3cret") =>
  new Request("https://app.test/api/linkedin-digest", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LINKEDIN_DIGEST_SECRET = "s3cret";
  process.env.RESEND_API_KEY = "re_x";
  process.env.DIGEST_FROM = "Calderyn <digest@calderyncompany.com>";
  sendEmail.mockResolvedValue({ sent: true, id: "email_1" });
});

describe("POST /api/linkedin-digest", () => {
  it("401s without a valid bearer", async () => {
    const { action } = await import("../api.linkedin-digest");
    const res = await action(routeArgs({ request: POST({ emails: goodEmails }, "Bearer nope"), params: {}, context: {} }));
    expect(res.status).toBe(401);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("405s a non-POST", async () => {
    const { action } = await import("../api.linkedin-digest");
    const req = new Request("https://app.test/api/linkedin-digest", { method: "GET" });
    const res = await action(routeArgs({ request: req, params: {}, context: {} }));
    expect(res.status).toBe(405);
  });

  it("400s invalid JSON", async () => {
    const { action } = await import("../api.linkedin-digest");
    const req = new Request("https://app.test/api/linkedin-digest", {
      method: "POST",
      headers: { Authorization: "Bearer s3cret", "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await action(routeArgs({ request: req, params: {}, context: {} }));
    expect(res.status).toBe(400);
  });

  it("400s (no open relay) when a recipient is outside calderyncompany.com", async () => {
    const { action } = await import("../api.linkedin-digest");
    const res = await action(routeArgs({
      request: POST({ emails: [{ to: "attacker@evil.com", subject: "s", text: "t" }] }),
      params: {},
      context: {},
    }));
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("500s when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    const { action } = await import("../api.linkedin-digest");
    const res = await action(routeArgs({ request: POST({ emails: goodEmails }), params: {}, context: {} }));
    expect(res.status).toBe(500);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends each post via Resend and returns per-email results", async () => {
    const { action } = await import("../api.linkedin-digest");
    const res = await action(routeArgs({ request: POST({ emails: goodEmails }), params: {}, context: {} }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, sentCount: 2, total: 2 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({
      apiKey: "re_x",
      from: "Calderyn <digest@calderyncompany.com>",
      to: "john@calderyncompany.com",
      subject: "Your post",
      text: "post one",
    });
  });

  it("502s when every send fails", async () => {
    sendEmail.mockResolvedValue({ sent: false, error: "Resend 500 Internal" });
    const { action } = await import("../api.linkedin-digest");
    const res = await action(routeArgs({ request: POST({ emails: goodEmails }), params: {}, context: {} }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ sent: false, sentCount: 0, total: 2 });
  });
});
