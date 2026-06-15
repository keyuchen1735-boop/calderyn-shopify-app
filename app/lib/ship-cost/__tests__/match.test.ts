import { describe, it, expect } from "vitest";
import { matchInvoiceLines } from "../match";
import type { ParsedInvoiceRow } from "../csv";

const orders = [
  { id: "o1", orderNumber: "#1001", trackingNos: ["1Z999"] },
  { id: "o2", orderNumber: "#1002", trackingNos: ["1Z888", "1Z777"] },
];

describe("matchInvoiceLines", () => {
  it("matches by order number first", () => {
    const rows: ParsedInvoiceRow[] = [{ orderRef: "#1001", trackingNo: null, costCents: 450 }];
    const { matched, unmatched } = matchInvoiceLines(rows, orders);
    expect(matched).toEqual([{ matchedOrderId: "o1", orderRef: "#1001", trackingNo: null, costCents: 450 }]);
    expect(unmatched).toEqual([]);
  });
  it("falls back to tracking number when order ref misses", () => {
    const rows: ParsedInvoiceRow[] = [{ orderRef: "#9999", trackingNo: "1Z777", costCents: 1200 }];
    const { matched } = matchInvoiceLines(rows, orders);
    expect(matched[0].matchedOrderId).toBe("o2");
  });
  it("normalizes order ref (case + leading #/spaces)", () => {
    const rows: ParsedInvoiceRow[] = [{ orderRef: " 1001 ", trackingNo: null, costCents: 100 }];
    expect(matchInvoiceLines(rows, orders).matched[0].matchedOrderId).toBe("o1");
  });
  it("surfaces unmatched lines instead of dropping them", () => {
    const rows: ParsedInvoiceRow[] = [{ orderRef: "#404", trackingNo: "NOPE", costCents: 700 }];
    const { matched, unmatched } = matchInvoiceLines(rows, orders);
    expect(matched).toEqual([]);
    expect(unmatched).toEqual([{ orderRef: "#404", trackingNo: "NOPE", costCents: 700, matchedOrderId: null }]);
  });
});
