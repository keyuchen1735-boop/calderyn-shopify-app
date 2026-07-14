import type { TrustedSlotManifest } from "~/lib/storefront-bundle/types";

export interface TrustedSlotHostProps {
  slot: TrustedSlotManifest;
  instanceId: string;
  compilerId: string;
  authorityKey: string;
}

export function TrustedSlotHost({ slot, instanceId, compilerId, authorityKey }: TrustedSlotHostProps) {
  const instance = instanceId === slot.id ? undefined : instanceId.slice(slot.id.length + 1);
  return (
    <div
      id={instanceId}
      data-cd-compiler-id={compilerId}
      data-cd-trusted-slot={slot.kind}
      data-cd-slot-scope={slot.scopeId ?? "root"}
      data-cd-authority-key={authorityKey}
      data-cd-host-size={slot.hostSize}
      data-cd-theme-tokens={slot.themeTokenIds.join(" ")}
      data-cd-shadow-mode="closed"
      data-cd-instance={instance}
      hidden={slot.kind === "cartDrawer"}
    />
  );
}
