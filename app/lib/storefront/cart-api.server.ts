import { clientIpKey, rateLimit } from "~/lib/rate-limit.server";
import {
  CartLineNotFoundError,
  VariantUnavailableError,
  getCartState,
} from "~/lib/order/cart.server";
import {
  clearCartId,
  commitCartId,
  readCartId,
  readCartIdentity,
  type CartIdentity,
} from "~/lib/storefront/cart-cookie.server";
import { isUuid } from "~/lib/ids";
import {
  canonicalizeStorefrontLinePersonalization,
  STOREFRONT_LINE_PERSONALIZATION_KEYS,
  type StorefrontLinePersonalization,
} from "~/lib/storefront-runtime/trusted-slots";

const PRIVATE_JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  Vary: "Cookie, Host, Origin",
};

export function storefrontJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(PRIVATE_JSON_HEADERS);
  new Headers(init.headers).forEach((value, key) => headers.append(key, value));
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function storefrontOk(data: unknown, init: ResponseInit = {}): Response {
  return storefrontJson({ ok: true, data }, init);
}

export function storefrontError(status: number, code: string, init: ResponseInit = {}): Response {
  return storefrontJson({ ok: false, error: { code } }, { ...init, status });
}

export function requireStorefrontOrigin(request: Request): Response | null {
  const expected = new URL(request.url).origin;
  return request.headers.get("Origin") === expected ? null : storefrontError(403, "bad_origin");
}

export function requireJsonContent(request: Request): Response | null {
  const value = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  return value === "application/json" ? null : storefrontError(415, "unsupported_media_type");
}

export async function parseStrictObject(
  request: Request,
  allowedKeys: readonly string[],
): Promise<Record<string, unknown> | Response> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return storefrontError(400, "invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return storefrontError(422, "invalid_request");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    return storefrontError(422, "invalid_request");
  }
  return record;
}

export function parseStorefrontLinePersonalization(
  value: unknown,
): StorefrontLinePersonalization | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > STOREFRONT_LINE_PERSONALIZATION_KEYS.length) return null;
  if (keys.some((key) =>
    [...key].length > 40 ||
    !STOREFRONT_LINE_PERSONALIZATION_KEYS.includes(
      key as (typeof STOREFRONT_LINE_PERSONALIZATION_KEYS)[number],
    ) ||
    typeof record[key] !== "string" ||
    [...(record[key] as string)].length > 240
  )) return null;
  return canonicalizeStorefrontLinePersonalization(record as StorefrontLinePersonalization);
}

export async function allowStorefrontRequest(
  request: Request,
  shopId: string,
  operation: string,
  limit = 30,
): Promise<boolean> {
  return rateLimit(clientIpKey(request, `storefront:${shopId}:${operation}`), limit, 60_000);
}

export type CartContext =
  | { kind: "absent" }
  | { kind: "mismatch" }
  | { kind: "stale"; clearCookie: string }
  | { kind: "active"; identity: CartIdentity; upgradeCookie: string | null };

export async function resolveCartContext(request: Request, shopId: string): Promise<CartContext> {
  const identity = await readCartIdentity(request);
  if (identity && identity.shopId !== shopId) return { kind: "mismatch" };
  const legacyCartId = identity ? null : await readCartId(request);
  const cartId = identity?.cartId ?? (legacyCartId && isUuid(legacyCartId) ? legacyCartId : null);
  if (!cartId) return { kind: "absent" };
  const state = await getCartState(shopId, cartId);
  if (state !== "cart") return { kind: "stale", clearCookie: await clearCartId() };
  return {
    kind: "active",
    identity: identity ?? { cartId, shopId },
    upgradeCookie: identity ? null : await commitCartId(cartId, shopId),
  };
}

export function cartContextError(context: Exclude<CartContext, { kind: "active" }>): Response {
  if (context.kind === "mismatch") return storefrontError(403, "cart_shop_mismatch");
  if (context.kind === "stale") {
    return storefrontError(409, "cart_not_found", { headers: { "Set-Cookie": context.clearCookie } });
  }
  return storefrontError(409, "cart_not_found");
}

export function mapCartError(error: unknown): Response | null {
  if (error instanceof VariantUnavailableError) return storefrontError(409, "variant_unavailable");
  if (error instanceof CartLineNotFoundError) return storefrontError(404, "cart_line_not_found");
  return null;
}
