// PDF rendering for purchase-order drafts. Re-rendered on demand from the
// PoDraft snapshot in action_audit.params.po — nothing is stored as a blob.

import type { PDFFont } from "pdf-lib";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { fmtMoneyDec } from "~/lib/format";
import type { PoDraft } from "./draft.server";

const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const MARGIN = 54;
const INK = rgb(0.13, 0.14, 0.16);
const MUTED = rgb(0.45, 0.47, 0.5);
const RULE = rgb(0.8, 0.82, 0.85);

/** null = unknown — rendered as "TBD", never $0 (matches draft.server.ts). */
const money = (cents: number | null) => (cents === null ? "TBD" : fmtMoneyDec(cents));

// Standard fonts are WinAnsi-encoded; merchant data (product titles, shop
// names) may carry characters outside it. Replace those rather than throw.
const sanitize = (s: string) =>
  s.replace(/[^\x20-\x7e -ÿ–—‘’“”•]/g, "?");

export async function renderPoPdf(po: PoDraft): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(po.po_number);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE_W, PAGE_H]);

  const text = (
    str: string,
    x: number,
    y: number,
    opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb> } = {},
  ) =>
    page.drawText(sanitize(str), {
      x,
      y,
      size: opts.size ?? 10,
      font: opts.font ?? font,
      color: opts.color ?? INK,
    });
  const rightText = (
    str: string,
    rightX: number,
    y: number,
    opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb> } = {},
  ) => {
    const f = opts.font ?? font;
    const size = opts.size ?? 10;
    text(str, rightX - f.widthOfTextAtSize(sanitize(str), size), y, opts);
  };
  const hr = (y: number) =>
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.75,
      color: RULE,
    });

  // ---- Header -------------------------------------------------------------
  let y = PAGE_H - MARGIN - 10;
  text("PURCHASE ORDER", MARGIN, y, { size: 20, font: bold });
  rightText("DRAFT", PAGE_W - MARGIN, y + 2, { size: 12, font: bold, color: MUTED });
  y -= 22;
  text(po.po_number, MARGIN, y, { size: 11, font: bold });
  rightText(`Date: ${po.issued_at.slice(0, 10)}`, PAGE_W - MARGIN, y, { color: MUTED });
  y -= 14;
  hr(y);

  // ---- Parties: buyer / supplier / ship-to --------------------------------
  y -= 24;
  const col2 = MARGIN + 180;
  const col3 = MARGIN + 360;
  text("FROM (BUYER)", MARGIN, y, { size: 8, font: bold, color: MUTED });
  text("TO (SUPPLIER)", col2, y, { size: 8, font: bold, color: MUTED });
  text("SHIP TO", col3, y, { size: 8, font: bold, color: MUTED });
  y -= 14;
  text(po.shop_domain, MARGIN, y);
  // Supplier and ship-to are intentionally blank — filled in by hand before
  // sending (send pathway TBD; no supplier data in the schema).
  for (const row of [0, 1, 2]) {
    const lineY = y - row * 16;
    text("_______________________", col2, lineY, { color: MUTED });
    text("_______________________", col3, lineY, { color: MUTED });
  }
  y -= 3 * 16 + 14;
  hr(y);

  // ---- Line items ----------------------------------------------------------
  y -= 20;
  const colSku = MARGIN;
  const colDesc = MARGIN + 90;
  const colQtyR = MARGIN + 340;
  const colUnitR = MARGIN + 420;
  const colTotalR = PAGE_W - MARGIN;
  text("SKU", colSku, y, { size: 8, font: bold, color: MUTED });
  text("DESCRIPTION", colDesc, y, { size: 8, font: bold, color: MUTED });
  rightText("QTY", colQtyR, y, { size: 8, font: bold, color: MUTED });
  rightText("UNIT COST", colUnitR, y, { size: 8, font: bold, color: MUTED });
  rightText("LINE TOTAL", colTotalR, y, { size: 8, font: bold, color: MUTED });
  y -= 6;
  hr(y);
  for (const line of po.lines) {
    y -= 16;
    const lineTotal =
      line.unit_cost_cents === null ? null : line.quantity * line.unit_cost_cents;
    text(line.sku, colSku, y);
    text(line.title, colDesc, y);
    rightText(String(line.quantity), colQtyR, y);
    rightText(money(line.unit_cost_cents), colUnitR, y);
    rightText(money(lineTotal), colTotalR, y);
  }
  y -= 10;
  hr(y);

  // ---- Totals ---------------------------------------------------------------
  y -= 18;
  rightText(money(po.subtotal_cents), colTotalR, y);
  rightText("Subtotal", colTotalR - 90, y, { color: MUTED });
  y -= 16;
  rightText(money(po.total_cents), colTotalR, y, { font: bold, size: 11 });
  rightText("Total", colTotalR - 90, y, { font: bold, size: 11 });

  // ---- Notes & terms --------------------------------------------------------
  y -= 36;
  text("NOTES", MARGIN, y, { size: 8, font: bold, color: MUTED });
  y -= 13;
  text(
    `Generated from Calderyn alert ${po.alert_id} (${po.detector_id}).`,
    MARGIN,
    y,
    { size: 9, color: MUTED },
  );
  y -= 12;
  text("DRAFT — send pathway TBD; review before sending to a supplier.", MARGIN, y, {
    size: 9,
    color: MUTED,
  });
  text(
    "Payment terms, delivery date, and shipping method to be confirmed with supplier.",
    MARGIN,
    MARGIN,
    { size: 8, color: MUTED },
  );

  return doc.save();
}
