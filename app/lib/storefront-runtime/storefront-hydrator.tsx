import { useEffect } from "react";
import type { StorefrontBundleV1, StorefrontRouteId } from "~/lib/storefront-bundle/types";
import type { PublicPresentationData } from "./public-data.server";
import { hydrateStorefront } from "./hydrate";
import type { StorefrontRuntimeHandle } from "./hydrate";
import type { CommerceIntent, ResolvedRouteTarget, RuntimeAdapters } from "./actions";

type RuntimeMode = "public" | "preview";
export type RuntimeFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function hrefFor(target: ResolvedRouteTarget, mode: RuntimeMode): string {
  if (mode === "preview") {
    if (target.routeId === "account" || target.routeId === "policy") return "#";
    const query = new URLSearchParams({ route: target.routeId });
    if (typeof target.params.handle === "string") query.set("handle", target.params.handle);
    if (typeof target.params.query === "string") query.set("q", target.params.query);
    return `/dashboard/store/preview?${query.toString()}`;
  }
  const base: Record<ResolvedRouteTarget["routeId"], string> = {
    home: "/storefront", collection: "/storefront/collections", product: "/storefront/products",
    search: "/storefront/search", cart: "/storefront/cart", checkout: "/storefront/checkout",
    account: "/storefront/account", policy: "/storefront/policies",
  };
  let href = base[target.routeId];
  if ((target.routeId === "product" || target.routeId === "collection") && typeof target.params.handle === "string") {
    href += `/${encodeURIComponent(target.params.handle)}`;
  } else if (target.routeId === "policy" && typeof target.params.policyId === "string") {
    href += `/${encodeURIComponent(target.params.policyId)}`;
  } else if (target.routeId === "search" && typeof target.params.query === "string") {
    href += `?q=${encodeURIComponent(target.params.query)}`;
  }
  return href;
}

function publicCommerceRequest(intent: CommerceIntent): [string, Record<string, unknown>] | null {
  if (intent.type === "cart.add") return ["/storefront/api/cart/add", { variantId: intent.variantId, quantity: intent.quantity }];
  if (intent.type === "cart.quantity") return ["/storefront/api/cart/quantity", { lineId: intent.lineId, quantity: intent.quantity }];
  if (intent.type === "cart.remove") return ["/storefront/api/cart/remove", { lineId: intent.lineId }];
  if (intent.type === "cart.clear") return ["/storefront/api/cart/clear", {}];
  return null;
}

function previewCommerceBody(intent: CommerceIntent): FormData | null {
  const body = new FormData();
  if (intent.type === "cart.add") {
    body.set("intent", "add"); body.set("variantId", intent.variantId); body.set("quantity", String(intent.quantity));
  } else if (intent.type === "cart.quantity") {
    body.set("intent", "quantity"); body.set("lineId", intent.lineId); body.set("quantity", String(intent.quantity));
  } else if (intent.type === "cart.remove") {
    body.set("intent", "remove"); body.set("lineId", intent.lineId);
  } else if (intent.type === "cart.clear") body.set("intent", "clear");
  else if (intent.type === "checkout.start") body.set("intent", "checkout");
  else return null;
  return body;
}

export function createRuntimeAdapters(input: {
  mode: RuntimeMode;
  data?: PublicPresentationData;
  fetcher?: RuntimeFetcher;
  refresh?: () => void;
}): RuntimeAdapters {
  const fetcher = input.fetcher ?? fetch;
  const refresh = input.refresh ?? (() => globalThis.window?.location.reload());
  let selectedVariant = input.data?.product?.variants.find((entry) => entry.available) ?? null;
  const dispatch = (intent: CommerceIntent) => {
    if (intent.type === "variant.select") return;
    if (input.mode === "preview") {
      const body = previewCommerceBody(intent);
      if (body) void fetcher("/dashboard/store/preview", { method: "POST", body, credentials: "same-origin" }).then(refresh);
      return;
    }
    if (intent.type === "checkout.start") {
      globalThis.window?.location.assign("/storefront/checkout");
      return;
    }
    const request = publicCommerceRequest(intent);
    if (request) void fetcher(request[0], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request[1]),
      credentials: "same-origin",
    }).then(refresh);
  };
  return {
    navigate(target) {
      const href = hrefFor(target, input.mode);
      if (href !== "#") globalThis.window?.location.assign(href);
    },
    search(intent) {
      if (intent.type === "update") return;
      const query = intent.type === "clear" ? "" : String(intent.query ?? "").slice(0, 200);
      globalThis.window?.location.assign(hrefFor({ routeId: "search", params: { query } }, input.mode));
    },
    collection(intent) {
      const url = new URL(globalThis.window?.location.href ?? "https://runtime.invalid/");
      if (intent.type === "filter") url.searchParams.set(`filter.${intent.facetId}`, String(intent.value ?? ""));
      else if (intent.type === "sort") url.searchParams.set("sort", String(intent.value ?? ""));
      else if (intent.type === "page") url.searchParams.set("cursor", String(intent.cursor ?? ""));
      globalThis.window?.location.assign(`${url.pathname}${url.search}`);
    },
    commerce: {
      mount({ shadowRoot, slot, authorityKey, bridge }) {
        if (slot.kind === "variantPicker") {
          const select = document.createElement("select");
          select.setAttribute("aria-label", "Choose an option");
          for (const variant of input.data?.product?.variants ?? []) {
            if (!variant.available) continue;
            const option = document.createElement("option");
            option.value = variant.id;
            option.textContent = variant.title;
            select.append(option);
          }
          select.onchange = () => {
            const variant = input.data?.product?.variants.find((entry) => entry.id === select.value) ?? null;
            if (!variant || !input.data?.product) return;
            selectedVariant = variant;
            bridge({ type: "variant.select", productId: input.data.product.id, variantId: variant.id });
          };
          shadowRoot.append(select);
          return;
        }
        if (slot.kind === "cartLineControls") {
          const lineId = authorityKey.startsWith("cartLine:") ? authorityKey.slice("cartLine:".length) : "";
          const line = input.data?.cart?.lines.find((entry) => entry.id === lineId);
          const quantity = document.createElement("input");
          quantity.type = "number";
          quantity.min = "1";
          quantity.max = "99";
          quantity.value = String(line?.quantity ?? 1);
          quantity.setAttribute("aria-label", `Quantity for ${line?.title ?? "item"}`);
          quantity.onchange = () => bridge({ type: "cart.quantity", lineId, quantity: Number(quantity.value) });
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "Remove";
          remove.onclick = () => bridge({ type: "cart.remove", lineId });
          shadowRoot.append(quantity, remove);
          return;
        }
        const button = document.createElement("button");
        button.type = "button";
        if (slot.kind === "addToCart") {
          button.textContent = selectedVariant ? "Add to cart" : "Sold out";
          button.disabled = !selectedVariant;
          if (selectedVariant && input.data?.product) button.onclick = () => bridge({
            type: "cart.add", productId: input.data!.product!.id, variantId: selectedVariant!.id, quantity: 1,
          });
        } else if (slot.kind === "cartSummary" || slot.kind === "cartDrawer") {
          button.textContent = "Checkout";
          button.onclick = () => bridge({ type: "checkout.start", cartId: input.data?.cart?.id ?? "preview" });
        } else {
          button.textContent = "View options";
        }
        shadowRoot.append(button);
      },
      dispatch(command) { dispatch(command.intent); },
    },
  };
}

export function StorefrontHydrator(props: {
  bundle: StorefrontBundleV1;
  routeId: StorefrontRouteId;
  data: PublicPresentationData;
  mode: RuntimeMode;
}) {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-cd-bundle-runtime='1']");
    if (!root) return;
    const adapters = createRuntimeAdapters({ mode: props.mode, data: props.data });
    const handles: StorefrontRuntimeHandle[] = [];
    const shell = root.querySelector<HTMLElement>("[data-cd-bundle-shell]");
    if (shell) handles.push(hydrateStorefront({ root: shell, artifact: props.bundle.shell, adapters }));
    if (props.routeId !== "checkout") {
      const route = root.querySelector<HTMLElement>(`[data-cd-bundle-route='${props.routeId}']`);
      if (route) handles.push(hydrateStorefront({ root: route, artifact: props.bundle.routes[props.routeId], adapters }));
    }
    return () => handles.forEach((handle) => handle.teardown());
  }, [props.bundle, props.data, props.mode, props.routeId]);
  return null;
}
