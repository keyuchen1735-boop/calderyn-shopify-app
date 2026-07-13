import type { TrustedSlotManifest } from "~/lib/storefront-bundle/types";

export interface TrustedSlotHostProps {
  slot: TrustedSlotManifest;
}

export function TrustedSlotHost({ slot }: TrustedSlotHostProps) {
  return (
    <div
      id={slot.id}
      data-cd-trusted-slot={slot.kind}
      data-cd-slot-scope={slot.scopeId ?? "root"}
      data-cd-host-size={slot.hostSize}
      data-cd-theme-tokens={slot.themeTokenIds.join(" ")}
      data-cd-shadow-mode="closed"
    />
  );
}
