import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { PoDraft } from "../draft.server";
import { renderPoPdf, type PoPdfData } from "../pdf.server";

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

  it("flows a many-line PO onto multiple pages instead of off the page edge", async () => {
    const many: PoDraft = {
      ...PO,
      lines: Array.from({ length: 60 }, (_, i) => ({
        sku: `SKU-${i}`,
        title: `Product line number ${i}`,
        quantity: i + 1,
        unit_cost_cents: 1000 + i,
      })),
      subtotal_cents: 999_999,
      total_cents: 999_999,
    };
    const bytes = await renderPoPdf(many);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("wraps long notes across lines and renders without throwing", async () => {
    const withNotes: PoPdfData = {
      ...PO,
      notes:
        "Please deliver to the loading dock at the rear of the building between " +
        "8am and 11am. Call ahead on arrival. " +
        "Word\nwith\nembedded\nnewlines and a very-long-unbroken-token-" +
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa " +
        "and more trailing text ".repeat(20),
    };
    const bytes = await renderPoPdf(withNotes);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});
