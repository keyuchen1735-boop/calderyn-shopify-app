// Route tests for storefront.invoice.$token.pay.tsx (orders phase 3, Task 2). Same convention as
// storefront.checkout-confirmation.test.ts: fake the tenant resolver + the invoice-session
// resolver (its own state-matrix behavior is unit-tested in invoice.server.test.ts).
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { LoaderFunctionArgs } from "@remix-run/node";

const resolveStorefrontShop = vi.fn();
const payableInvoiceSession = vi.fn();

vi.mock("~/lib/storefront/shop.server", () => ({
  resolveStorefrontShop: (...a: unknown[]) => resolveStorefrontShop(...a),
}));
vi.mock("~/lib/order/invoice.server", () => ({
  payableInvoiceSession: (...a: unknown[]) => payableInvoiceSession(...a),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { loader } from "../storefront.invoice.$token.pay";

const args = (token: string | undefined) =>
  ({
    request: new Request(`https://shop.example/storefront/invoice/${token ?? ""}/pay`),
    params: { token },
    context: {},
  }) as unknown as LoaderFunctionArgs;

beforeEach(() => {
  vi.clearAllMocks();
  resolveStorefrontShop.mockResolvedValue("shop-1");
});

describe("storefront.invoice.$token.pay loader", () => {
  it("302s to the freshly minted Stripe session url when the invoice is still payable", async () => {
    payableInvoiceSession.mockResolvedValue({ kind: "pay", url: "https://stripe/pay/cs_1" });
    const res = (await loader(args("tok-abc"))) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://stripe/pay/cs_1");
    expect(payableInvoiceSession).toHaveBeenCalledWith("shop-1", "tok-abc");
  });

  it("302s to the existing confirmation page when the invoice is already paid", async () => {
    payableInvoiceSession.mockResolvedValue({ kind: "paid", confirmationToken: "tok-abc" });
    const res = (await loader(args("tok-abc"))) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/storefront/checkout/confirmation/tok-abc");
  });

  it("renders the void page (200, no redirect) for a cancelled/refunded invoice", async () => {
    payableInvoiceSession.mockResolvedValue({ kind: "void" });
    const res = (await loader(args("tok-abc"))) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.json()).toEqual({ kind: "void" });
  });

  it("404s on an unknown token (no order, no PII) and looks up scoped to the shop", async () => {
    payableInvoiceSession.mockResolvedValue(null);
    const err = await loader(args("unknown-token")).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
    expect(payableInvoiceSession).toHaveBeenCalledWith("shop-1", "unknown-token");
  });

  it("404s on a missing token without calling the resolver", async () => {
    const err = await loader(args(undefined)).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
    expect(payableInvoiceSession).not.toHaveBeenCalled();
  });
});
