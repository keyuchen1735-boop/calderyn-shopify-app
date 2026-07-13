import type { TrustedSlotManifest } from "~/lib/storefront-bundle/types";

export interface TrustedSlotHostProps {
  slot: TrustedSlotManifest;
  instanceId: string;
  authorityKey: string;
}

export function TrustedSlotHost({ slot, instanceId, authorityKey }: TrustedSlotHostProps) {
  return (
    <div
      id={instanceId}
      data-cd-trusted-slot={slot.kind}
      data-cd-slot-scope={slot.scopeId ?? "root"}
      data-cd-authority-key={authorityKey}
      data-cd-host-size={slot.hostSize}
      data-cd-theme-tokens={slot.themeTokenIds.join(" ")}
      data-cd-shadow-mode="closed"
    />
  );
}
