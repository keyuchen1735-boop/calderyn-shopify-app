// Organic-action learning sweep: the merchant's own platform actions become
// deterministic calibration signals. Fail-safe posture throughout — stale
// syncs, missing rows, and Calderyn-executed actions must produce NO signal.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sweepOrganicSignals, IMPLICIT_ALPHA } from "../organic.server";

const NOW = Date.parse("2026-07-02T12:00:00Z");
const FRESH = "2026-07-02T11:00:00Z"; // 1h old — fresh
const STALE = "2026-06-25T00:00:00Z"; // way past the 24h freshness bar

interface StubOpts {
  /** v_autopilot_candidates rows (open alerts with campaigns). */
  candidates?: Array<Record<string, unknown>>;
  /** ad_campaign_dim rows returned for any .in() campaign lookup. */
  campaigns?: Array<Record<string, unknown>>;
  /** Succeeded pause audits for the ALERT-scoped lookup (implicit sweep). */
  alertAudits?: Array<Record<string, unknown>>;
  /** Autonomous pause audits (reversal sweep source). */
  autopilotAudits?: Array<Record<string, unknown>>;
  /** Rows for the reversed-through-Calderyn .or() lookup. */
  reversalAudits?: Array<Record<string, unknown>>;
  /** Rows returned when acknowledging the alert (empty = lost the race). */
  ackRows?: Array<Record<string, unknown>>;
  /** Ledger upsert result rows (empty = duplicate). */
  ledgerRows?: Array<Record<string, unknown>>;
  /** alerts.detector_id lookup for the reversal pair. */
  alertDetector?: string | null;
}

function makeStub(opts: StubOpts & { rpcErrorFor?: string }) {
  const rpc = vi.fn(async (name: string) => {
    if (opts.rpcErrorFor === name) return { data: null, error: { message: "rpc boom" } };
    return { data: null, error: null };
  });
  const feedbackInserts: Array<Record<string, unknown>> = [];
  const feedbackDeletes: string[] = [];
  const ackedAlertIds: string[] = [];
  const reopenedAlertIds: string[] = [];

  const sb = {
    rpc,
    from: (table: string) => {
      if (table === "v_autopilot_candidates") {
        const chain: Record<string, unknown> = {};
        chain.eq = vi.fn().mockReturnValue(chain);
        chain.not = vi.fn().mockReturnValue(chain);
        chain.limit = vi.fn(async () => ({ data: opts.candidates ?? [], error: null }));
        return { select: () => chain };
      }
      if (table === "ad_campaign_dim") {
        return {
          select: () => ({
            in: async () => ({ data: opts.campaigns ?? [], error: null }),
          }),
        };
      }
      if (table === "action_audit") {
        const chain: Record<string, unknown> = {};
        let audits = opts.alertAudits ?? [];
        chain.eq = vi.fn((col: string, val: unknown) => {
          // The reversal-source lookup filters actor autopilot; the implicit
          // sweep's campaign-scoped disqualifier filters params->>campaign_id.
          if (col === "actor_user_id" && val === "autopilot") {
            audits = opts.autopilotAudits ?? [];
          }
          return chain;
        });
        chain.is = vi.fn().mockReturnValue(chain);
        chain.gte = vi.fn().mockReturnValue(chain);
        chain.or = vi.fn(() => {
          audits = opts.reversalAudits ?? [];
          return chain;
        });
        chain.limit = vi.fn(async () => ({ data: audits, error: null }));
        return { select: () => chain };
      }
      if (table === "alerts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data:
                    opts.alertDetector === null
                      ? null
                      : { detector_id: opts.alertDetector ?? "campaign_below_breakeven" },
                  error: null,
                }),
              }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: () => ({
              eq: (_c: string, alertId: string) => {
                // The ack ends with .select(); the compensating re-open is
                // awaited directly after the third .eq — support both.
                const done = () => {
                  if (patch.status === "open") reopenedAlertIds.push(alertId);
                  return { data: opts.ackRows ?? [{ id: alertId }], error: null };
                };
                return {
                  eq: () => ({
                    select: async () => {
                      const rows = opts.ackRows ?? [{ id: alertId }];
                      if (patch.status === "acknowledged" && rows.length > 0) {
                        ackedAlertIds.push(alertId);
                      }
                      return { data: rows, error: null };
                    },
                    // Thenable so `await ...eq()` (no .select) also resolves.
                    then: (resolve: (v: unknown) => unknown) => resolve(done()),
                  }),
                };
              },
            }),
          }),
        };
      }
      if (table === "action_feedback") {
        return {
          insert: async (row: Record<string, unknown>) => {
            feedbackInserts.push(row);
            return { error: null };
          },
          upsert: (row: Record<string, unknown>) => {
            feedbackInserts.push(row);
            return { select: async () => ({ data: opts.ledgerRows ?? [{ id: "af-1" }], error: null }) };
          },
          delete: () => ({
            eq: () => ({
              eq: async (_c: string, id: string) => {
                feedbackDeletes.push(id);
                return { error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;

  return { sb, rpc, feedbackInserts, feedbackDeletes, ackedAlertIds, reopenedAlertIds };
}

const OPEN_PAUSE_CAND = {
  alert_id: "al-1",
  detector_id: "campaign_below_breakeven",
  campaign_id: "11111111-1111-1111-1111-111111111111",
};

describe("organic sweep — implicit pause approvals", () => {
  beforeEach(() => vi.clearAllMocks());

  it("credits half an approval and acknowledges the alert when the merchant paused it themselves", async () => {
    const { sb, rpc, ackedAlertIds, feedbackInserts } = makeStub({
      candidates: [OPEN_PAUSE_CAND],
      campaigns: [{ id: "11111111-1111-1111-1111-111111111111", status: "paused", last_synced_at: FRESH }],
      alertAudits: [],
    });
    const summary = await sweepOrganicSignals("shop-1", sb, NOW);

    expect(summary.implicitApprovals).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(rpc).toHaveBeenCalledWith("calibration_record_implicit_approval", {
      p_shop_id: "shop-1",
      p_detector_id: "campaign_below_breakeven",
      p_action_kind: "pause_campaign",
      p_alpha_delta: IMPLICIT_ALPHA,
    });
    expect(ackedAlertIds).toEqual(["al-1"]);
    expect(feedbackInserts[0]).toMatchObject({ decision: "approve", alert_id: "al-1" });
  });

  it("produces NO signal when the campaign sync is stale", async () => {
    const { sb, rpc } = makeStub({
      candidates: [OPEN_PAUSE_CAND],
      campaigns: [{ id: "11111111-1111-1111-1111-111111111111", status: "paused", last_synced_at: STALE }],
    });
    const summary = await sweepOrganicSignals("shop-1", sb, NOW);
    expect(summary.implicitApprovals).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("produces NO signal while the campaign is still active", async () => {
    const { sb, rpc } = makeStub({
      candidates: [OPEN_PAUSE_CAND],
      campaigns: [{ id: "11111111-1111-1111-1111-111111111111", status: "active", last_synced_at: FRESH }],
    });
    const summary = await sweepOrganicSignals("shop-1", sb, NOW);
    expect(summary.implicitApprovals).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("produces NO signal when the pause was executed THROUGH Calderyn", async () => {
    const { sb, rpc, ackedAlertIds } = makeStub({
      candidates: [OPEN_PAUSE_CAND],
      campaigns: [{ id: "11111111-1111-1111-1111-111111111111", status: "paused", last_synced_at: FRESH }],
      alertAudits: [{ id: "aud-1" }],
    });
    const summary = await sweepOrganicSignals("shop-1", sb, NOW);
    expect(summary.implicitApprovals).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(ackedAlertIds).toEqual([]);
  });

  it("does not credit when the alert was already acknowledged (lost the exactly-once race)", async () => {
    const { sb, rpc } = makeStub({
      candidates: [OPEN_PAUSE_CAND],
      campaigns: [{ id: "11111111-1111-1111-1111-111111111111", status: "paused", last_synced_at: FRESH }],
      ackRows: [],
    });
    const summary = await sweepOrganicSignals("shop-1", sb, NOW);
    expect(summary.implicitApprovals).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("skips detectors whose recommendation is not pause_campaign", async () => {
    const { sb, rpc } = makeStub({
      candidates: [{ alert_id: "al-2", detector_id: "campaign_scaling_opportunity", campaign_id: "11111111-1111-1111-1111-111111111111" }],
      campaigns: [{ id: "11111111-1111-1111-1111-111111111111", status: "paused", last_synced_at: FRESH }],
    });
    const summary = await sweepOrganicSignals("shop-1", sb, NOW);
    expect(summary.implicitApprovals).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("treats MANY simultaneous paused suggestions as a bulk/seasonal pause: no credits, no acks", async () => {
    const candidates = [1, 2, 3, 4].map((n) => ({
      alert_id: `al-${n}`,
      detector_id: "campaign_below_breakeven",
      campaign_id: `00000000-0000-0000-0000-00000000000${n}`,
    }));
    const { sb, rpc, ackedAlertIds } = makeStub({
      candidates,
      campaigns: candidates.map((c) => ({
        id: c.campaign_id,
        status: "paused",
        last_synced_at: FRESH,
      })),
      alertAudits: [],
    });
    const summary = await sweepOrganicSignals("shop-1", sb, NOW);
    expect(summary.implicitApprovals).toBe(0);
    expect(ackedAlertIds).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reverts the ack when the credit RPC fails, so the alert stays visible and retryable", async () => {
    const { sb, ackedAlertIds, reopenedAlertIds } = makeStub({
      candidates: [OPEN_PAUSE_CAND],
      campaigns: [{ id: "11111111-1111-1111-1111-111111111111", status: "paused", last_synced_at: FRESH }],
      alertAudits: [],
      rpcErrorFor: "calibration_record_implicit_approval",
    });
    const summary = await sweepOrganicSignals("shop-1", sb, NOW);
    expect(summary.implicitApprovals).toBe(0);
    expect(summary.errors.some((e) => e.includes("implicit-approval rpc failed"))).toBe(true);
    expect(ackedAlertIds).toEqual(["al-1"]);
    expect(reopenedAlertIds).toEqual(["al-1"]);
  });
});

const AUTONOMOUS_PAUSE = {
  id: "aud-auto-1",
  alert_id: "al-9",
  params: { campaign_id: "99999999-9999-9999-9999-999999999999" },
  created_at: "2026-07-01T08:00:00Z",
};

describe("organic sweep — out-of-band reversals", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records an autonomous undo when the merchant re-activated a campaign autopilot paused", async () => {
    const { sb, rpc, feedbackInserts } = makeStub({
      autopilotAudits: [AUTONOMOUS_PAUSE],
      campaigns: [{ id: "99999999-9999-9999-9999-999999999999", status: "active", last_synced_at: FRESH }],
      reversalAudits: [],
    });
    const summary = await sweepOrganicSignals("shop-1", sb, NOW);

    expect(summary.reversals).toBe(1);
    expect(rpc).toHaveBeenCalledWith("calibration_record_undo", {
      p_shop_id: "shop-1",
      p_detector_id: "campaign_below_breakeven",
      p_action_kind: "pause_campaign",
      p_autonomous: true,
    });
    expect(feedbackInserts.some((f) => f.decision === "reversal" && f.audit_id === "aud-auto-1")).toBe(true);
  });

  it("rolls the reversal ledger row back when the undo RPC fails (signal retryable next night)", async () => {
    const { sb, feedbackDeletes } = makeStub({
      autopilotAudits: [AUTONOMOUS_PAUSE],
      campaigns: [{ id: "99999999-9999-9999-9999-999999999999", status: "active", last_synced_at: FRESH }],
      reversalAudits: [],
      rpcErrorFor: "calibration_record_undo",
    });
    const summary = await sweepOrganicSignals("shop-1", sb, NOW);
    expect(summary.reversals).toBe(0);
    expect(summary.errors.some((e) => e.includes("reversal undo rpc failed"))).toBe(true);
    expect(feedbackDeletes).toEqual(["af-1"]);
  });

  it("does NOT double-record: a duplicate ledger row skips the undo RPC", async () => {
    const { sb, rpc } = makeStub({
      autopilotAudits: [AUTONOMOUS_PAUSE],
      campaigns: [{ id: "99999999-9999-9999-9999-999999999999", status: "active", last_synced_at: FRESH }],
      reversalAudits: [],
      ledgerRows: [],
    });
    const summary = await sweepOrganicSignals("shop-1", sb, NOW);
    expect(summary.reversals).toBe(0);
    expect(rpc).not.toHaveBeenCalledWith("calibration_record_undo", expect.anything());
  });

  it("produces NO signal when the reversal happened THROUGH Calderyn (undo/resume audit exists)", async () => {
    const { sb, rpc } = makeStub({
      autopilotAudits: [AUTONOMOUS_PAUSE],
      campaigns: [{ id: "99999999-9999-9999-9999-999999999999", status: "active", last_synced_at: FRESH }],
      reversalAudits: [{ id: "aud-undo-1" }],
    });
    const summary = await sweepOrganicSignals("shop-1", sb, NOW);
    expect(summary.reversals).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("produces NO signal while the campaign is still paused, or when the sync predates the pause", async () => {
    const stillPaused = makeStub({
      autopilotAudits: [AUTONOMOUS_PAUSE],
      campaigns: [{ id: "99999999-9999-9999-9999-999999999999", status: "paused", last_synced_at: FRESH }],
    });
    expect((await sweepOrganicSignals("shop-1", stillPaused.sb, NOW)).reversals).toBe(0);

    const preSync = makeStub({
      autopilotAudits: [{ ...AUTONOMOUS_PAUSE, created_at: "2026-07-02T11:30:00Z" }],
      // Synced BEFORE the pause landed — status "active" proves nothing.
      campaigns: [{ id: "99999999-9999-9999-9999-999999999999", status: "active", last_synced_at: FRESH }],
    });
    expect((await sweepOrganicSignals("shop-1", preSync.sb, NOW)).reversals).toBe(0);
  });
});
