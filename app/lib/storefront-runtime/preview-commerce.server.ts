import { createCookie } from "@remix-run/node";
import type { PublicCart, PublicMoney } from "./public-data.server";
import { getSupabase } from "~/lib/supabase.server";
import type { StorefrontVersionRecord } from "./release-resolution.server";

const COOKIE_NAME = "cd_storefront_preview";
const MAX_AGE_SECONDS = 60 * 60 * 8;
const MAX_BUNDLE_LINES = 12;
const MAX_QUANTITY = 999;
const MAX_COOKIE_BYTES = 4096;

export interface PreviewCommerceLine {
  lineId: string;
  variantId: string;
  title: string;
  quantity: number;
  unitPrice: PublicMoney;
}

export interface PreviewCommerceSnapshot {
  shopId: string;
  lines: PreviewCommerceLine[];
}

export interface PreviewCommerceSession extends PreviewCommerceSnapshot {
  cart: PublicCart;
}

function previewCookie() {
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("SHOPIFY_API_SECRET must be set to sign the preview commerce cookie in production");
  }
  return createCookie(COOKIE_NAME, {
    path: "/dashboard/store/preview",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE_SECONDS,
    secrets: secret ? [secret] : [],
  });
}

function isMoney(value: unknown): value is PublicMoney {
  return Boolean(value) && typeof value === "object" &&
    Number.isSafeInteger((value as PublicMoney).cents) && (value as PublicMoney).cents >= 0 &&
    typeof (value as PublicMoney).currency === "string" && /^[A-Z]{3}$/.test((value as PublicMoney).currency);
}

function sanitizeLines(value: unknown): PreviewCommerceLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): PreviewCommerceLine[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const line = candidate as Partial<PreviewCommerceLine>;
    if (typeof line.lineId !== "string" || typeof line.variantId !== "string" ||
        typeof line.title !== "string" || !Number.isInteger(line.quantity) ||
        Number(line.quantity) < 1 || Number(line.quantity) > MAX_QUANTITY || !isMoney(line.unitPrice)) return [];
    return [{
      lineId: line.lineId.slice(0, 128),
      variantId: line.variantId.slice(0, 128),
      title: line.title.slice(0, 120),
      quantity: Number(line.quantity),
      unitPrice: line.unitPrice,
    }];
  });
}

function cartFor(snapshot: PreviewCommerceSnapshot): PublicCart {
  const currency = snapshot.lines[0]?.unitPrice.currency ?? "USD";
  const lines = snapshot.lines.map((line) => ({
    id: line.lineId,
    title: line.title,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    total: { cents: line.unitPrice.cents * line.quantity, currency: line.unitPrice.currency },
  }));
  const subtotal = lines.reduce((sum, line) => sum + line.total.cents, 0);
  return {
    id: `preview:${snapshot.shopId}`,
    count: lines.reduce((sum, line) => sum + line.quantity, 0),
    lines,
    subtotal: { cents: subtotal, currency },
    discounts: { cents: 0, currency },
    total: { cents: subtotal, currency },
  };
}

export async function readPreviewCommerceSession(request: Request, shopId: string): Promise<PreviewCommerceSession> {
  const parsed: unknown = await previewCookie().parse(request.headers.get("Cookie"));
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const lines = record.shopId === shopId ? sanitizeLines(record.lines) : [];
  const snapshot = { shopId, lines };
  return { ...snapshot, cart: cartFor(snapshot) };
}

export async function commitPreviewCommerceSession(snapshot: PreviewCommerceSnapshot): Promise<string> {
  const serialized = await previewCookie().serialize({ shopId: snapshot.shopId, lines: sanitizeLines(snapshot.lines) });
  if (new TextEncoder().encode(serialized).byteLength > MAX_COOKIE_BYTES) {
    throw new Error("Preview cart exceeds cookie capacity");
  }
  return serialized;
}

export function createPreviewCommerceAdapter(initial: PreviewCommerceSnapshot) {
  const snapshot: PreviewCommerceSnapshot = { shopId: initial.shopId, lines: sanitizeLines(initial.lines) };
  return {
    add(line: PreviewCommerceLine) {
      const valid = sanitizeLines([line])[0];
      if (!valid) throw new Error("Invalid preview cart line");
      const existing = snapshot.lines.find((entry) => entry.variantId === valid.variantId);
      if (existing) existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + valid.quantity);
      else snapshot.lines.push(valid);
    },
    addBundle(lines: readonly PreviewCommerceLine[]) {
      if (lines.length < 2 || lines.length > MAX_BUNDLE_LINES) throw new Error("Invalid preview bundle");
      const next = snapshot.lines.map((line) => ({ ...line, unitPrice: { ...line.unitPrice } }));
      for (const line of lines) {
        const valid = sanitizeLines([line])[0];
        if (!valid || valid.quantity !== 1) throw new Error("Invalid preview bundle line");
        const existing = next.find((entry) => entry.variantId === valid.variantId);
        if (existing) {
          if (existing.unitPrice.currency !== valid.unitPrice.currency || existing.unitPrice.cents !== valid.unitPrice.cents || existing.quantity >= MAX_QUANTITY) {
            throw new Error("Invalid preview bundle line");
          }
          existing.quantity += 1;
        } else {
          if (next[0] && next[0].unitPrice.currency !== valid.unitPrice.currency) {
            throw new Error("Invalid preview bundle line");
          }
          next.push(valid);
        }
      }
      snapshot.lines.splice(0, snapshot.lines.length, ...next);
    },
    setQuantity(lineId: string, quantity: number) {
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) throw new Error("Invalid preview quantity");
      const index = snapshot.lines.findIndex((line) => line.lineId === lineId);
      if (index < 0) return;
      if (quantity === 0) snapshot.lines.splice(index, 1);
      else snapshot.lines[index].quantity = quantity;
    },
    remove(lineId: string) {
      const index = snapshot.lines.findIndex((line) => line.lineId === lineId);
      if (index >= 0) snapshot.lines.splice(index, 1);
    },
    clear() {
      snapshot.lines.splice(0);
    },
    checkout() {
      return { kind: "simulated" as const, status: "ready" as const };
    },
    snapshot(): PreviewCommerceSnapshot {
      return { shopId: snapshot.shopId, lines: snapshot.lines.map((line) => ({ ...line, unitPrice: { ...line.unitPrice } })) };
    },
    cart(): PublicCart {
      return cartFor(snapshot);
    },
  };
}

export async function readPreviewBundleVersion(shopId: string): Promise<StorefrontVersionRecord | null> {
  const release = await getSupabase()
    .from("storefront_release")
    .select("draft_version_id")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (release.error) throw release.error;
  const versionId = release.data?.draft_version_id;
  if (!versionId) return null;
  const result = await getSupabase()
    .from("storefront_bundle_version")
    .select("id, shop_id, source_kind, status, schema_version, runtime_version, validation_profile_version, artifact_hash, bundle_json, created_at")
    .eq("shop_id", shopId)
    .eq("id", versionId)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return null;
  const row = result.data as Record<string, unknown>;
  const version: StorefrontVersionRecord = {
    id: String(row.id),
    shopId: String(row.shop_id),
    sourceKind: row.source_kind as StorefrontVersionRecord["sourceKind"],
    status: row.status as StorefrontVersionRecord["status"],
    schemaVersion: Number(row.schema_version),
    runtimeVersion: Number(row.runtime_version),
    validationProfileVersion: Number(row.validation_profile_version),
    artifactHash: String(row.artifact_hash),
    artifact: row.bundle_json as StorefrontVersionRecord["artifact"],
    createdAt: String(row.created_at),
  };
  return version.status === "validated" && version.runtimeVersion === 1 &&
    version.schemaVersion === 1 && version.validationProfileVersion === 1 &&
    version.artifact.sourceKind !== "legacy" ? version : null;
}
