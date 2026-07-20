import type { TrustedSlotManifest } from "~/lib/storefront-bundle/types";

export const STOREFRONT_LINE_PERSONALIZATION_KEYS = [
  "engraving",
  "giftNote",
  "giftWrap",
  "recipient",
] as const;

export type StorefrontLinePersonalization = Partial<
  Record<(typeof STOREFRONT_LINE_PERSONALIZATION_KEYS)[number], string>
>;

export function canonicalizeStorefrontLinePersonalization(
  value: StorefrontLinePersonalization,
): StorefrontLinePersonalization {
  return Object.fromEntries(
    STOREFRONT_LINE_PERSONALIZATION_KEYS.flatMap((key) =>
      Object.hasOwn(value, key) ? [[key, value[key]!]] : [],
    ),
  );
}

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
