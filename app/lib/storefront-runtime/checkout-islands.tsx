import type { ReactNode } from "react";
import type { CheckoutLayoutManifest } from "~/lib/storefront-bundle/types";

const SECTION_LABELS: Record<CheckoutLayoutManifest["sectionOrder"][number], string> = {
  contact: "Contact",
  shipping: "Shipping address",
  delivery: "Delivery",
  consent: "Consent",
  payment: "Payment",
  summary: "Order summary",
};

export interface CheckoutIslandsProps {
  layout: CheckoutLayoutManifest;
  children?: ReactNode;
}

export function CheckoutIslands({ layout, children }: CheckoutIslandsProps) {
  return (
    <div
      data-cd-checkout-islands={layout.columnMode}
      data-cd-spacing-token={layout.spacingTokenId}
      data-cd-surface-tokens={layout.surfaceTokenIds.join(" ")}
    >
      {layout.sectionOrder.map((section) => (
        <section key={section} data-cd-checkout-section={section} aria-label={SECTION_LABELS[section]} />
      ))}
      {children ? <div data-cd-checkout-platform-root>{children}</div> : null}
    </div>
  );
}
