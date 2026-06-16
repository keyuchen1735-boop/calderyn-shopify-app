import { describe, it, expect } from "vitest";
import { parseInvoiceCsv } from "../csv";

describe("parseInvoiceCsv", () => {
  it("parses order#, tracking#, and dollar cost into cents", () => {
    const { rows, errors } = parseInvoiceCsv(
      "order,tracking,cost\n#1001,1Z999,4.50\n#1002,1Z888,12.00\n",
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { orderRef: "#1001", trackingNo: "1Z999", costCents: 450 },
      { orderRef: "#1002", trackingNo: "1Z888", costCents: 1200 },
    ]);
  });
  it("recognizes header aliases (order#, tracking#, amount)", () => {
    const { rows } = parseInvoiceCsv("order#,tracking#,amount\n#5,T5,3.00\n");
    expect(rows[0]).toEqual({ orderRef: "#5", trackingNo: "T5", costCents: 300 });
  });
  it("flags rows with an unparseable cost instead of dropping them", () => {
    const { rows, errors } = parseInvoiceCsv("order,cost\n#1,abc\n#2,5.00\n");
    expect(rows).toEqual([{ orderRef: "#2", trackingNo: null, costCents: 500 }]);
    expect(errors).toEqual([{ line: 2, reason: 'unparseable cost "abc"' }]);
  });
  it("errors when no cost column is present", () => {
    const { rows, errors } = parseInvoiceCsv("order,tracking\n#1,T1\n");
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ line: 0, reason: "missing required cost column" }]);
  });
  it("requires at least one of order or tracking per row", () => {
    const { rows, errors } = parseInvoiceCsv("order,tracking,cost\n,,5.00\n");
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ line: 2, reason: "row has neither order ref nor tracking number" }]);
  });
});
