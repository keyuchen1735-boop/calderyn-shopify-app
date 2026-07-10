import { describe, expect, it } from "vitest";
import { mapPoRow } from "./po-list.server";

const BASE = {
  id: "audit-1",
  action_kind: "create_po_draft",
  outcome: "succeeded",
  last_error: null,
  created_at: "2026-07-01T12:00:00Z",
};

describe("mapPoRow", () => {
  it("maps a full PO snapshot row, including hasPdf", () => {
    const row = mapPoRow({
      ...BASE,
      params: {
        po: {
          po_number: "PO-20260701-ABCD1234",
          lines: [{ sku: "SKU-1", title: "Tee", quantity: 5, unit_cost_cents: 250 }],
          total_cents: 1250,
        },
      },
    });
    expect(row).toEqual({
      id: "audit-1",
      poNumber: "PO-20260701-ABCD1234",
      sku: "SKU-1",
      lineCount: 1,
      totalCents: 1250,
      outcome: "succeeded",
      createdAt: "2026-07-01T12:00:00Z",
      lastError: null,
      hasPdf: true,
    });
  });

  it("returns nulls and hasPdf false when params carry no PO snapshot", () => {
    const row = mapPoRow({ ...BASE, outcome: "failed", last_error: "boom", params: {} });
    expect(row).toEqual({
      id: "audit-1",
      poNumber: null,
      sku: null,
      lineCount: 0,
      totalCents: null,
      outcome: "failed",
      createdAt: "2026-07-01T12:00:00Z",
      lastError: "boom",
      hasPdf: false,
    });
  });

  it("treats malformed lines as zero lines but keeps a finite total", () => {
    const row = mapPoRow({
      ...BASE,
      params: { po: { po_number: "PO-X", lines: "not-an-array", total_cents: 900 } },
    });
    expect(row.lineCount).toBe(0);
    expect(row.sku).toBeNull();
    expect(row.totalCents).toBe(900);
    expect(row.hasPdf).toBe(true);
  });

  it("nulls the total unless po.total_cents is a finite number", () => {
    for (const bad of ["1250", null, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const row = mapPoRow({
        ...BASE,
        params: { po: { po_number: "PO-X", lines: [], total_cents: bad } },
      });
      expect(row.totalCents).toBeNull();
    }
  });

  it("requires action_kind create_po_draft for hasPdf, matching the PDF route", () => {
    const row = mapPoRow({
      ...BASE,
      action_kind: "set_price",
      params: { po: { po_number: "PO-X", lines: [], total_cents: 100 } },
    });
    expect(row.hasPdf).toBe(false);
  });

  it("null params yield the same empty shape as {}", () => {
    const row = mapPoRow({ ...BASE, params: null });
    expect(row.poNumber).toBeNull();
    expect(row.lineCount).toBe(0);
    expect(row.hasPdf).toBe(false);
  });
});
