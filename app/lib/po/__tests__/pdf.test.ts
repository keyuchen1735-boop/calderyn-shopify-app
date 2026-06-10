import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { PoDraft } from "../draft.server";
import { renderPoPdf } from "../pdf.server";

const PO: PoDraft = {
  po_number: "PO-20260608-0F3B2A1C",
  issued_at: "2026-06-08T12:00:00.000Z",
  shop_domain: "peak-pine.myshopify.com",
  alert_id: "0f3b2a1c-9d8e-4f00-aaaa-bbbbccccdddd",
  detector_id: "reorder_timing",
  lines: [
    {
      sku: "WND-BRK-S",
      title: "Trailhead Windbreaker — S",
      quantity: 120,
      unit_cost_cents: 2350,
    },
  ],
  subtotal_cents: 282_000,
  total_cents: 282_000,
};

describe("renderPoPdf", () => {
  it("returns PDF bytes (%PDF- magic)", async () => {
    const bytes = await renderPoPdf(PO);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("parses back as a one-page document titled with the PO number", async () => {
    const bytes = await renderPoPdf(PO);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe(PO.po_number);
  });

  it("renders a valid PDF when unit cost is unknown (TBD totals)", async () => {
    const tbd: PoDraft = {
      ...PO,
      lines: [{ ...PO.lines[0], unit_cost_cents: null }],
      subtotal_cents: null,
      total_cents: null,
    };
    const bytes = await renderPoPdf(tbd);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });
});
