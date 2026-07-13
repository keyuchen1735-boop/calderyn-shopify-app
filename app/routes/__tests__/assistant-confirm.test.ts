import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";

// Spies live in vi.hoisted so the mock factories below can close over them —
// vi.mock is hoisted above these imports by Vitest, so it applies before the
// route module (and its real imports) are evaluated.
const {
  sessionMock,
  rateLimitMock,
  claimMock,
  dismissMock,
  markExecutedMock,
  runClaimedMock,
  appendMessageMock,
} = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  rateLimitMock: vi.fn(),
  claimMock: vi.fn(),
  dismissMock: vi.fn(),
  markExecutedMock: vi.fn(),
  runClaimedMock: vi.fn(),
  appendMessageMock: vi.fn(),
}));

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: (...a: unknown[]) => sessionMock(...a),
}));
vi.mock("~/lib/rate-limit.server", () => ({
  rateLimit: (...a: unknown[]) => rateLimitMock(...a),
  clientIpKey: () => "ip",
}));
vi.mock("~/lib/assistant/actions/pending.server", () => ({
  claimPendingAction: (...a: unknown[]) => claimMock(...a),
  dismissPendingAction: (...a: unknown[]) => dismissMock(...a),
  markPendingExecuted: (...a: unknown[]) => markExecutedMock(...a),
}));
vi.mock("~/lib/assistant/actions/execute.server", () => ({
  runClaimedAction: (...a: unknown[]) => runClaimedMock(...a),
}));
vi.mock("~/lib/assistant/conversations.server", () => ({
  appendMessage: (...a: unknown[]) => appendMessageMock(...a),
}));

// eslint-disable-next-line import/first -- module under test must import after vi.mock() hoisting
import { action } from "../dashboard.api.assistant.confirm";

const ORIGIN = "https://calderyncompany.com";
const SHOP = "00000000-0000-0000-0000-000000000010";

function post(body: unknown, origin: string | null = ORIGIN, method = "POST"): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return new Request(`${ORIGIN}/dashboard/api/assistant/confirm`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function run(request: Request): Promise<Response> {
  return action({ request, params: {}, context: {} } as ActionFunctionArgs) as Promise<Response>;
}

const RECEIPT = {
  action: "pause_campaign",
  summary: 'Paused "Summer Sale"',
  auditId: "audit-1",
  undoable: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
  sessionMock.mockResolvedValue({ shopId: SHOP, shopDomain: null, sessionId: "s" });
  rateLimitMock.mockResolvedValue(true);
  claimMock.mockResolvedValue({
    action: "pause_campaign",
    input: { campaign_id: "c1" },
    conversationId: "conv-1",
  });
  dismissMock.mockResolvedValue(true);
  markExecutedMock.mockResolvedValue(undefined);
  runClaimedMock.mockResolvedValue(RECEIPT);
  appendMessageMock.mockResolvedValue({
    id: "m2",
    role: "assistant",
    content: 'Confirmed — Paused "Summer Sale"',
    draftedAction: null,
    receipts: [RECEIPT],
    pendingAction: null,
    createdAt: "2026-07-09T00:00:00Z",
  });
});

describe("dashboard.api.assistant.confirm action", () => {
  it("returns 405 for a non-POST method", async () => {
    const res = await run(post({ pending_id: "p1", decision: "confirm" }, ORIGIN, "PUT"));
    expect(res.status).toBe(405);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("returns 422 when pending_id is missing", async () => {
    const res = await run(post({ decision: "confirm" }));
    expect(res.status).toBe(422);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("returns 409 with 'expired' in the message when the claim has expired", async () => {
    claimMock.mockResolvedValue({ error: "expired" });
    const res = await run(post({ pending_id: "p1", decision: "confirm" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("pending_unavailable");
    expect(body.message.toLowerCase()).toContain("expired");
    expect(runClaimedMock).not.toHaveBeenCalled();
  });

  it("returns 409 when the pending action was already used", async () => {
    claimMock.mockResolvedValue({ error: "already_used" });
    const res = await run(post({ pending_id: "p1", decision: "confirm" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message.toLowerCase()).toContain("already");
  });

  it("returns 409 when the pending action is not found", async () => {
    claimMock.mockResolvedValue({ error: "not_found" });
    const res = await run(post({ pending_id: "p1", decision: "confirm" }));
    expect(res.status).toBe(409);
  });

  it("on confirm, runs the claimed action (not the body's) with the expected idempotency key, marks executed, and returns the receipt", async () => {
    const res = await run(
      post({
        pending_id: "p1",
        decision: "confirm",
        // Tampered fields — must be ignored in favor of the claimed row.
        action: "delete_everything",
        input: { evil: true },
      }),
    );
    expect(res.status).toBe(200);
    expect(claimMock).toHaveBeenCalledWith(SHOP, "p1");
    expect(runClaimedMock).toHaveBeenCalledWith("pause_campaign", { campaign_id: "c1" }, {
      shopId: SHOP,
      conversationId: "conv-1",
      idempotencyKey: "assistant-confirm:p1",
    });
    expect(markExecutedMock).toHaveBeenCalledWith(SHOP, "p1", "audit-1");
    const body = (await res.json()) as { receipt: typeof RECEIPT };
    expect(body.receipt).toEqual(RECEIPT);
  });

  it("persists the outcome into the conversation thread and returns it as `message`", async () => {
    const res = await run(post({ pending_id: "p1", decision: "confirm" }));
    expect(appendMessageMock).toHaveBeenCalledWith(SHOP, "conv-1", {
      role: "assistant",
      content: 'Confirmed — Paused "Summer Sale"',
      receipts: [RECEIPT],
      pendingAction: null,
    });
    const body = (await res.json()) as { message: { content: string } };
    expect(body.message.content).toBe('Confirmed — Paused "Summer Sale"');
  });

  it("still returns the receipt with 200 when persisting the confirmation message fails", async () => {
    appendMessageMock.mockRejectedValue(new Error("db down"));
    const res = await run(post({ pending_id: "p1", decision: "confirm" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { receipt: typeof RECEIPT; message: unknown };
    expect(body.receipt).toEqual(RECEIPT);
    expect(body.message).toBeNull();
  });

  it("still returns the receipt with 200 when marking pending executed fails, but appendMessage is still attempted", async () => {
    markExecutedMock.mockRejectedValue(new Error("db down"));
    const res = await run(post({ pending_id: "p1", decision: "confirm" }));
    expect(res.status).toBe(200);
    expect(markExecutedMock).toHaveBeenCalledWith(SHOP, "p1", "audit-1");
    expect(appendMessageMock).toHaveBeenCalled();
    const body = (await res.json()) as { receipt: typeof RECEIPT; message: { content: string } };
    expect(body.receipt).toEqual(RECEIPT);
    expect(body.message.content).toBe('Confirmed — Paused "Summer Sale"');
  });

  it("on dismiss, calls dismissPendingAction and never runs the action", async () => {
    const res = await run(post({ pending_id: "p1", decision: "dismiss" }));
    expect(res.status).toBe(200);
    expect(dismissMock).toHaveBeenCalledWith(SHOP, "p1");
    expect(claimMock).not.toHaveBeenCalled();
    expect(runClaimedMock).not.toHaveBeenCalled();
    const body = (await res.json()) as { dismissed: boolean };
    expect(body.dismissed).toBe(true);
  });

  it("rejects a cross-origin POST (CSRF) before touching any pending action", async () => {
    const res = await run(post({ pending_id: "p1", decision: "confirm" }, "https://evil.example")).catch(
      (thrown: Response) => thrown,
    );
    expect((res as Response).status).toBe(403);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("returns 502 with action_failed when runClaimedAction throws after claim succeeds, without marking executed or persisting the message", async () => {
    runClaimedMock.mockRejectedValue(new Error("platform rejected the refund"));
    const res = await run(post({ pending_id: "p1", decision: "confirm" })).catch(
      (thrown: Response) => thrown,
    );
    expect((res as Response).status).toBe(502);
    const body = (await (res as Response).json()) as { error: string; message: string; receipt: unknown };
    expect(body.error).toBe("action_failed");
    expect(body.message).toContain("platform rejected the refund");
    expect(body.receipt).toBeNull();
    // Claim is consumed by design; markExecuted and appendMessage must not run.
    expect(markExecutedMock).not.toHaveBeenCalled();
    expect(appendMessageMock).not.toHaveBeenCalled();
  });
});
