// PDF rendering for purchase orders. Re-rendered on demand — nothing is stored
// as a blob. Two callers share it: the Autopilot draft snapshot in
// action_audit.params.po (a full PoDraft, which stays assignable to PoPdfData)
// and the real purchase_order rows, which map into PoPdfData with a supplier
// name, status label, ETA, and merchant notes instead of alert provenance.

import type { PDFFont } from "pdf-lib";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { fmtMoneyDec } from "~/lib/format";
import type { PoLine } from "./draft.server";

/** Renderer input. PoDraft satisfies this shape; real POs fill the optional
 *  supplier/status/ETA/notes fields and omit the alert provenance. */
export interface PoPdfData {
  po_number: string;
  issued_at: string;
  shop_domain: string;
  lines: PoLine[];
  subtotal_cents: number | null;
  total_cents: number | null;
  /** Alert provenance — present only on Autopilot draft snapshots. */
  alert_id?: string;
  detector_id?: string;
  /** Real-PO extras. */
  supplier_name?: string | null;
  status_label?: string;
  expected_at?: string | null;
  notes?: string | null;
}

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

export async function renderPoPdf(po: PoPdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(po.po_number);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([PAGE_W, PAGE_H]);

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
  // Draw text constrained to maxWidth: shrink the font toward `min` first
  // (keeps long SKUs fully legible), then ellipsis-truncate only if it still
  // overflows at the floor size. Without this, long values paint across the
  // next column. "…" is WinAnsi-encodable so it survives the standard font.
  const fitText = (
    str: string,
    x: number,
    y: number,
    maxWidth: number,
    opts: { size?: number; min?: number; font?: PDFFont; color?: ReturnType<typeof rgb> } = {},
  ) => {
    const f = opts.font ?? font;
    const min = opts.min ?? 7;
    const clean = sanitize(str);
    let size = opts.size ?? 10;
    while (size > min && f.widthOfTextAtSize(clean, size) > maxWidth) size -= 0.5;
    let out = clean;
    if (f.widthOfTextAtSize(out, size) > maxWidth) {
      while (out.length > 1 && f.widthOfTextAtSize(out + "…", size) > maxWidth)
        out = out.slice(0, -1);
      out += "…";
    }
    page.drawText(out, { x, y, size, font: f, color: opts.color ?? INK });
  };
  // Greedy word-wrap into lines that fit maxWidth. Collapses runs of
  // whitespace (so embedded newlines become spaces rather than "?") and
  // hard-breaks any single token longer than the width so nothing runs off
  // the edge. Used for merchant notes, which can be long.
  const wrapText = (str: string, maxWidth: number, size: number, f: PDFFont): string[] => {
    const clean = sanitize(str.replace(/\s+/g, " ")).trim();
    if (!clean) return [];
    const lines: string[] = [];
    let cur = "";
    for (const word of clean.split(" ")) {
      let w = word;
      while (f.widthOfTextAtSize(w, size) > maxWidth) {
        let cut = w.length - 1;
        while (cut > 1 && f.widthOfTextAtSize(w.slice(0, cut), size) > maxWidth) cut -= 1;
        if (cur) {
          lines.push(cur);
          cur = "";
        }
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > maxWidth) {
        if (cur) lines.push(cur);
        cur = w;
      } else {
        cur = next;
      }
    }
    if (cur) lines.push(cur);
    return lines;
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
  rightText((po.status_label ?? "DRAFT").toUpperCase(), PAGE_W - MARGIN, y + 2, {
    size: 12,
    font: bold,
    color: MUTED,
  });
  y -= 22;
  text(po.po_number, MARGIN, y, { size: 11, font: bold });
  rightText(`Date: ${po.issued_at.slice(0, 10)}`, PAGE_W - MARGIN, y, { color: MUTED });
  if (po.expected_at) {
    y -= 14;
    rightText(`Expected: ${po.expected_at}`, PAGE_W - MARGIN, y, { color: MUTED });
  }
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
  // Supplier name prints when known (real POs); the rest stays blank lines,
  // filled in by hand before sending. Ship-to is always written in by hand.
  if (po.supplier_name) fitText(po.supplier_name, col2, y, col3 - col2 - 12, { size: 10 });
  for (const row of [0, 1, 2]) {
    const lineY = y - row * 16;
    if (!(row === 0 && po.supplier_name)) {
      text("_______________________", col2, lineY, { color: MUTED });
    }
    text("_______________________", col3, lineY, { color: MUTED });
  }
  y -= 3 * 16 + 14;
  hr(y);

  // ---- Line items ----------------------------------------------------------
  y -= 20;
  const colSku = MARGIN;
  const colDesc = MARGIN + 150;
  const colQtyR = MARGIN + 340;
  const skuMaxW = colDesc - colSku - 10;
  const descMaxW = colQtyR - colDesc - 40;
  const colUnitR = MARGIN + 420;
  const colTotalR = PAGE_W - MARGIN;
  const drawLineItemsHeader = () => {
    text("SKU", colSku, y, { size: 8, font: bold, color: MUTED });
    text("DESCRIPTION", colDesc, y, { size: 8, font: bold, color: MUTED });
    rightText("QTY", colQtyR, y, { size: 8, font: bold, color: MUTED });
    rightText("UNIT COST", colUnitR, y, { size: 8, font: bold, color: MUTED });
    rightText("LINE TOTAL", colTotalR, y, { size: 8, font: bold, color: MUTED });
    y -= 6;
    hr(y);
  };
  drawLineItemsHeader();
  // A PO can carry up to 100 lines; flow onto additional pages (re-drawing the
  // column header on each) instead of running the rows off the bottom edge.
  for (const line of po.lines) {
    if (y - 16 < MARGIN + 44) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      drawLineItemsHeader();
    }
    y -= 16;
    const lineTotal =
      line.unit_cost_cents === null ? null : line.quantity * line.unit_cost_cents;
    fitText(line.sku, colSku, y, skuMaxW);
    fitText(line.title, colDesc, y, descMaxW);
    rightText(String(line.quantity), colQtyR, y);
    rightText(money(line.unit_cost_cents), colUnitR, y);
    rightText(money(lineTotal), colTotalR, y);
  }
  // Keep the totals + notes block together: start a fresh page if the last row
  // left too little room (more when there are notes to wrap below the totals).
  if (y < MARGIN + (po.notes ? 210 : 96)) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
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
  if (po.notes) {
    const noteLines = wrapText(po.notes, PAGE_W - 2 * MARGIN, 9, font);
    // Cap to the lines that fit above the footer at MARGIN; ellipsize the last
    // shown line when the note is longer so it reads as clipped, not complete.
    const capacity = Math.max(0, Math.floor((y - (MARGIN + 18)) / 12));
    const shown = noteLines.slice(0, capacity);
    if (shown.length && noteLines.length > shown.length) {
      shown[shown.length - 1] = `${shown[shown.length - 1]} …`;
    }
    for (const noteLine of shown) {
      text(noteLine, MARGIN, y, { size: 9, color: MUTED });
      y -= 12;
    }
  }
  if (po.alert_id && po.detector_id) {
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
  }
  text(
    "Payment terms, delivery date, and shipping method to be confirmed with supplier.",
    MARGIN,
    MARGIN,
    { size: 8, color: MUTED },
  );

  return doc.save();
}
