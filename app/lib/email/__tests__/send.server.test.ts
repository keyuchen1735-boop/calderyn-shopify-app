import { describe, it, expect, vi, afterEach } from "vitest";
import { sendEmail } from "../send.server";

afterEach(() => vi.restoreAllMocks());

describe("sendEmail", () => {
  it("posts to Resend with reply_to, array recipients, and base64 attachments", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "email_123" }), { status: 200 }));

    const out = await sendEmail({
      apiKey: "re_test",
      from: "Calderyn <bugs@calderyn.com>",
      to: ["a@x.com", "b@x.com"],
      replyTo: "merchant@store.com",
      subject: "Bug report",
      text: "something broke",
      attachments: [{ filename: "shot.png", content: "QUJD", contentType: "image/png" }],
    });

    expect(out).toEqual({ sent: true, id: "email_123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.to).toEqual(["a@x.com", "b@x.com"]);
    expect(body.reply_to).toBe("merchant@store.com");
    expect(body.attachments).toEqual([
      { filename: "shot.png", content: "QUJD", content_type: "image/png" },
    ]);
  });

  it("accepts a single string recipient (digest back-compat)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "e2" }), { status: 200 }));
    await sendEmail({ apiKey: "k", from: "f", to: "one@x.com", subject: "s", text: "t", cc: ["c@x.com"] });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.to).toEqual(["one@x.com"]);
    expect(body.cc).toEqual(["c@x.com"]);
    expect(body.reply_to).toBeUndefined();
  });

  it("returns a structured error (never throws) on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 422, statusText: "Unprocessable Entity" }),
    );
    const out = await sendEmail({ apiKey: "k", from: "f", to: "y@x.com", subject: "s", text: "t" });
    expect(out.sent).toBe(false);
    expect(out.error).toContain("Resend 422");
  });

  it("includes the html part in the payload when provided", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "e3" }), { status: 200 }));
    await sendEmail({ apiKey: "k", from: "f", to: "y@x.com", subject: "s", text: "t", html: "<b>t</b>" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.html).toBe("<b>t</b>");
  });

  it("returns a structured error (never throws) when fetch itself rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const out = await sendEmail({ apiKey: "k", from: "f", to: "y@x.com", subject: "s", text: "t" });
    expect(out.sent).toBe(false);
    expect(out.error).toBe("ECONNREFUSED");
  });

  it("includes custom headers only when provided", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "e4" }), { status: 200 }));
    await sendEmail({ apiKey: "k", from: "f", to: "y@x.com", subject: "s", text: "t",
      headers: { "List-Unsubscribe": "<https://x/u>" } });
    const withHeaders = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(withHeaders.headers).toEqual({ "List-Unsubscribe": "<https://x/u>" });

    await sendEmail({ apiKey: "k", from: "f", to: "y@x.com", subject: "s", text: "t" });
    const noHeaders = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(noHeaders.headers).toBeUndefined();
  });
});
