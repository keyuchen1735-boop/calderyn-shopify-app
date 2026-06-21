import { describe, it, expect, vi } from "vitest";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { loader } from "../app.queue";

const { queueListSpy } = vi.hoisted(() => ({
  queueListSpy: vi.fn(),
}));

// Stub Polaris so the route module loads without the real UI library.
vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  return {
    Badge: Stub,
    Banner: Stub,
    BlockStack: Stub,
    Box: Stub,
    Button: Stub,
    Card: Stub,
    InlineStack: Stub,
    Page: Stub,
    Text: Stub,
  };
});

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

vi.mock("~/lib/calderyn.server", () => ({
  calderynClient: () => ({
    queue: { list: (...a: unknown[]) => queueListSpy(...a) },
    calibration: {
      get: async () => ({ pct: null, updated_at: null }),
      learnedRules: async () => [],
    },
  }),
}));

// Stub format/labels/ids so they don't pull heavyweight deps.
vi.mock("~/lib/format", () => ({
  fmtMoney: (cents: number) => `$${(cents / 100).toFixed(2)}`,
}));
vi.mock("~/lib/labels", () => ({
  alertDetectorLabel: (id: string) => id,
  ACTION_LABELS: {} as Record<string, string>,
}));
vi.mock("~/lib/ids", () => ({
  newIdempotencyKey: () => "test-key",
}));

function args(): LoaderFunctionArgs {
  return {
    request: new Request("https://app.example.com/app/queue"),
    params: {},
    context: {},
  } as LoaderFunctionArgs;
}

describe("app.queue loader", () => {
  it("returns proposals from queue.list", async () => {
    const proposal = {
      alertId: "alert-1",
      detector_id: "campaign_below_breakeven",
      action_kind: "pause_campaign",
      title: "Campaign losing money",
      dollar_impact: 5000,
      confidence: 72,
      reasoning: "ROAS below breakeven for 7 days",
    };
    queueListSpy.mockResolvedValue([proposal]);

    const res = await loader(args());
    const payload = await (res as Response).json();
    expect(payload.proposals).toHaveLength(1);
    expect(payload.proposals[0].alertId).toBe("alert-1");
    expect(payload.proposals[0].confidence).toBe(72);
    expect(payload.error).toBeNull();
  });

  it("returns empty proposals and error when queue.list throws", async () => {
    queueListSpy.mockRejectedValue(
      Object.assign(new Error("db down"), { code: "DB_ERROR" }),
    );

    const res = await loader(args());
    const payload = await (res as Response).json();
    expect(payload.proposals).toHaveLength(0);
    expect(payload.error?.code).toBe("DB_ERROR");
  });
});
