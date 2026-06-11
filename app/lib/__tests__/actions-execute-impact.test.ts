// Recovered impact on the LEGACY actions.execute path (calderyn.server.ts).
// create_po_draft / exclude_geo / reallocate_inventory run through this path
// (not executeAction), so it must persist dollar_impact_at_exec on its
// succeeded audit rows too — otherwise those executions never count toward
// the Recovered-impact total. Mirrors the mocking style of
// audit-undo-meta.test.ts: only the supabase IO boundary is faked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { calderynClient } from "../calderyn.server";

const { insertSpy, sbState } = vi.hoisted(() => ({
  insertSpy: vi.fn(),
  sbState: { alertImpactDollars: null as number | null },
}));

vi.mock("../supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => ({
      select: () => {
        const b = {
          eq: () => b,
          // Idempotency lookup (fresh key) and the recovered-impact alert read.
          maybeSingle: async () => {
            if (table === "alerts")
              return { data: { dollar_impact: sbState.alertImpactDollars }, error: null };
            return { data: null, error: null };
          },
          // v_audit_view re-read of the inserted row.
          single: async () => ({
            data: { id: "aud-1", outcome: "succeeded" },
            error: null,
          }),
        };
        return b;
      },
      insert: (row: Record<string, unknown>) => {
        insertSpy(table, row);
        return {
          // action_audit insert chains .select().single(); the
          // action_idempotency insert is bare-awaited (thenable).
          select: () => ({
            single: async () => ({ data: { ...row, id: "aud-1" }, error: null }),
          }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        };
      },
    }),
  }),
  resolveShopId: async () => "shop-uuid",
}));

beforeEach(() => {
  insertSpy.mockReset();
  sbState.alertImpactDollars = null;
});

function auditInsert(): Record<string, unknown> | undefined {
  return insertSpy.mock.calls.find(([t]) => t === "action_audit")?.[1];
}

describe("actions.execute recovered impact (legacy path)", () => {
  it("records the alert's at-stake dollars for a value-recovering kind", async () => {
    sbState.alertImpactDollars = 1693.03;
    const client = calderynClient("acme.myshopify.com");

    await client.actions.execute({
      alertId: "alert-1",
      kind: "create_po_draft",
      params: { sku: "SKU-1", target: "SKU-1" },
      idempotencyKey: "k-impact-1",
    });

    expect(auditInsert()?.dollar_impact_at_exec).toBe(1693.03);
  });

  it("records zero for a neutral kind (snooze) even when the alert has impact", async () => {
    sbState.alertImpactDollars = 1693.03;
    const client = calderynClient("acme.myshopify.com");

    await client.actions.execute({
      alertId: "alert-1",
      kind: "snooze_alert",
      params: {},
      idempotencyKey: "k-impact-2",
    });

    expect(auditInsert()?.dollar_impact_at_exec).toBe(0);
  });
});
