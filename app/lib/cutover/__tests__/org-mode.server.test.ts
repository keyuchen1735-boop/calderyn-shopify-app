import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ORG_MODES,
  writesToOwned,
  isLegalOrgTransition,
  assertLegalOrgTransition,
  getOrgMode,
  transitionOrgMode,
  type OrgMode,
} from "../org-mode.server";

// getSupabase is replaced per-test via this holder so each test supplies its own stub.
let currentSb: unknown = null;
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => currentSb }));

// Go-live gates are mocked as passing by default; individual tests flip `gateError`
// to prove a failing gate blocks the transition before any write.
let gateError: Error | null = null;
const assertGoLiveGatesMock = vi.fn(async (_shopId: string) => {
  if (gateError) throw gateError;
});
vi.mock("../go-live.server", () => ({
  assertGoLiveGates: (shopId: string) => assertGoLiveGatesMock(shopId),
}));

/**
 * Purpose-built Supabase stub. `from("shops")` serves the initial
 * select().eq().maybeSingle() read AND the update().eq().eq().select() write;
 * it distinguishes them by whether update() was called on that builder.
 * `from("cutover_transition")` serves insert().select().single().
 */
function makeSb(opts: {
  shopFound?: boolean;
  shopMode?: string | null;
  updateRows?: Array<{ id: string }>;
  transitionRow?: Record<string, unknown>;
  onInsert?: (row: unknown) => void;
  onUpdate?: (set: unknown) => void;
}) {
  const builder = () => {
    let isUpdate = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
    const b: any = {
      select: () => b,
      eq: () => b,
      update: (set: unknown) => {
        isUpdate = true;
        opts.onUpdate?.(set);
        return b;
      },
      insert: (row: unknown) => {
        opts.onInsert?.(row);
        return b;
      },
      maybeSingle: async () => ({
        data: opts.shopFound === false ? null : { org_mode: opts.shopMode ?? null },
        error: null,
      }),
      single: async () => ({ data: opts.transitionRow ?? { id: "t1" }, error: null }),
      then: (res: (r: { data: unknown; error: null }) => unknown) =>
        res({ data: isUpdate ? (opts.updateRows ?? [{ id: "shop-1" }]) : [], error: null }),
    };
    return b;
  };
  return { from: () => builder() };
}

describe("writesToOwned", () => {
  it("is true only for live", () => {
    expect(writesToOwned("live")).toBe(true);
    for (const m of ORG_MODES.filter((x) => x !== "live")) {
      expect(writesToOwned(m as OrgMode)).toBe(false);
    }
  });
});

describe("legal transitions", () => {
  it("accepts the legal edges and rejects the rest", () => {
    expect(isLegalOrgTransition("mirror", "importing")).toBe(true);
    expect(isLegalOrgTransition("importing", "dual_run")).toBe(true);
    expect(isLegalOrgTransition("importing", "mirror")).toBe(true);
    expect(isLegalOrgTransition("dual_run", "live")).toBe(true);
    expect(isLegalOrgTransition("dual_run", "mirror")).toBe(true);
    expect(isLegalOrgTransition("live", "dual_run")).toBe(true);
    // illegal
    expect(isLegalOrgTransition("mirror", "live")).toBe(false);
    expect(isLegalOrgTransition("mirror", "mirror")).toBe(false); // identity not legal
    expect(isLegalOrgTransition("live", "mirror")).toBe(false);
  });

  it("assertLegalOrgTransition throws on an illegal move", () => {
    expect(() => assertLegalOrgTransition("mirror", "live")).toThrow();
    expect(() => assertLegalOrgTransition("mirror", "importing")).not.toThrow();
  });
});

describe("getOrgMode", () => {
  it("returns the stored mode", async () => {
    currentSb = makeSb({ shopMode: "live" });
    expect(await getOrgMode("shop-1")).toBe("live");
  });

  it("defaults to mirror when the stored value is null", async () => {
    currentSb = makeSb({ shopMode: null });
    expect(await getOrgMode("shop-1")).toBe("mirror");
  });

  it("throws when the shop is absent", async () => {
    currentSb = makeSb({ shopFound: false });
    await expect(getOrgMode("nope")).rejects.toThrow(/not found/);
  });

  it("throws on an unknown stored mode", async () => {
    currentSb = makeSb({ shopMode: "bogus" });
    await expect(getOrgMode("shop-1")).rejects.toThrow(/unknown org_mode/);
  });
});

describe("transitionOrgMode", () => {
  beforeEach(() => {
    gateError = null;
    assertGoLiveGatesMock.mockClear();
  });

  it("legal transition writes exactly one audit row BEFORE updating shops", async () => {
    let insertedRow: Record<string, unknown> | null = null;
    let updatedSet: Record<string, unknown> | null = null;
    currentSb = makeSb({
      shopMode: "mirror",
      updateRows: [{ id: "shop-1" }],
      transitionRow: {
        id: "t1",
        shop_id: "shop-1",
        from_mode: "mirror",
        to_mode: "importing",
        reason: "kickoff",
        occurred_at: "2026-07-01T00:00:00Z",
      },
      onInsert: (r) => (insertedRow = r as Record<string, unknown>),
      onUpdate: (s) => (updatedSet = s as Record<string, unknown>),
    });

    const t = await transitionOrgMode("shop-1", "importing", "kickoff");

    expect(insertedRow).toMatchObject({
      shop_id: "shop-1",
      from_mode: "mirror",
      to_mode: "importing",
      reason: "kickoff",
    });
    expect(updatedSet).toEqual({ org_mode: "importing" });
    expect(t).toMatchObject({ fromMode: "mirror", toMode: "importing", reason: "kickoff" });
  });

  it("throws on an illegal transition and writes nothing", async () => {
    let inserted = false;
    let updated = false;
    currentSb = makeSb({
      shopMode: "mirror",
      onInsert: () => (inserted = true),
      onUpdate: () => (updated = true),
    });
    await expect(transitionOrgMode("shop-1", "live")).rejects.toThrow();
    expect(inserted).toBe(false);
    expect(updated).toBe(false);
  });

  it("throws when the compare-and-set updates 0 rows (concurrent change)", async () => {
    currentSb = makeSb({ shopMode: "dual_run", updateRows: [] });
    await expect(transitionOrgMode("shop-1", "live")).rejects.toThrow(/expected exactly 1|0 rows/);
  });

  it("throws when the shop is absent and writes nothing", async () => {
    let inserted = false;
    currentSb = makeSb({ shopFound: false, onInsert: () => (inserted = true) });
    await expect(transitionOrgMode("nope", "importing")).rejects.toThrow(/not found/);
    expect(inserted).toBe(false);
  });

  it("runs the go-live gates on dual_run -> live (with the shop id)", async () => {
    currentSb = makeSb({
      shopMode: "dual_run",
      updateRows: [{ id: "shop-1" }],
      transitionRow: {
        id: "t2",
        shop_id: "shop-1",
        from_mode: "dual_run",
        to_mode: "live",
        reason: null,
        occurred_at: "2026-07-01T00:00:00Z",
      },
    });
    await transitionOrgMode("shop-1", "live");
    expect(assertGoLiveGatesMock).toHaveBeenCalledWith("shop-1");
  });

  it("a failing go-live gate blocks the transition and writes NOTHING", async () => {
    gateError = new Error("go-live blocked: 2 gate check(s) failing: paid_order");
    let inserted = false;
    let updated = false;
    currentSb = makeSb({
      shopMode: "dual_run",
      onInsert: () => (inserted = true),
      onUpdate: () => (updated = true),
    });
    await expect(transitionOrgMode("shop-1", "live")).rejects.toThrow(/go-live blocked/);
    expect(inserted).toBe(false);
    expect(updated).toBe(false);
  });

  it("does NOT run the gates on non-live transitions", async () => {
    currentSb = makeSb({ shopMode: "mirror", updateRows: [{ id: "shop-1" }] });
    await transitionOrgMode("shop-1", "importing");
    expect(assertGoLiveGatesMock).not.toHaveBeenCalled();
  });
});
