import type { StorefrontBundleV1, StorefrontRouteId } from "~/lib/storefront-bundle/types";
import { hydrateStorefront } from "~/lib/storefront-runtime/hydrate";
import type { PublicPresentationData } from "~/lib/storefront-runtime/public-data.server";
import { createRuntimeAdapters } from "~/lib/storefront-runtime/storefront-hydrator";

declare global {
  interface Window {
    __CD_HYDRATE_STOREFRONT_PROOF__?: (input: {
      bundle: StorefrontBundleV1;
      routeId: StorefrontRouteId;
      data: PublicPresentationData;
    }) => { shellHydrated: boolean; routeHydrated: boolean };
  }
}

window.__CD_HYDRATE_STOREFRONT_PROOF__ = ({ bundle, routeId, data }) => {
  const root = document.querySelector<HTMLElement>("[data-cd-bundle-runtime='1']");
  if (!root) throw new Error("Storefront proof root is missing");
  const proofRequests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const cartQuantities = new Map(data.cart?.lines.map((line) => [line.id, line.quantity]) ?? []);
  const initialCartCount = data.cart?.count ?? 0;
  let cartCount = initialCartCount;
  let refreshCount = 0;
  const publishProofState = () => {
    document.documentElement.dataset.cdProofRequests = JSON.stringify(proofRequests);
    document.documentElement.dataset.cdProofInitialCartCount = String(initialCartCount);
    document.documentElement.dataset.cdProofCartCount = String(cartCount);
    document.documentElement.dataset.cdProofRefreshCount = String(refreshCount);
  };
  const proofFetcher = async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        body = {};
      }
    } else if (init?.body instanceof FormData) {
      body = Object.fromEntries(init.body.entries());
    }
    proofRequests.push({ url, method: String(init?.method ?? "GET").toUpperCase(), body });
    if (url === "/storefront/api/cart/add") {
      cartCount += typeof body.quantity === "number" ? body.quantity : 0;
    } else if (url === "/storefront/api/cart/quantity" && typeof body.lineId === "string"
      && typeof body.quantity === "number") {
      const previous = cartQuantities.get(body.lineId) ?? 0;
      cartQuantities.set(body.lineId, body.quantity);
      cartCount += body.quantity - previous;
    } else if (url === "/storefront/api/cart/remove" && typeof body.lineId === "string") {
      cartCount -= cartQuantities.get(body.lineId) ?? 0;
      cartQuantities.delete(body.lineId);
    }
    publishProofState();
    return new Response(JSON.stringify({ ok: true, cartCount }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const refresh = () => {
    refreshCount += 1;
    publishProofState();
  };
  const locationAssign = (href: string) => {
    document.documentElement.dataset.cdProofNavigation = href;
  };
  publishProofState();
  const baseAdapters = createRuntimeAdapters({
    mode: "public",
    data,
    fetcher: proofFetcher,
    refresh,
    locationAssign,
    squareAccentCommerce: bundle.source.kind === "recipe"
      && bundle.source.templateId === "soft-chemistry"
      && bundle.source.templateVersion >= 6,
  });
  const commerce = baseAdapters.commerce;
  if (!commerce) throw new Error("Storefront commerce adapter is missing");
  const adapters = {
    ...baseAdapters,
    commerce: {
      mount: commerce.mount.bind(commerce),
      dispatch(command: Parameters<typeof commerce.dispatch>[0]) {
        document.documentElement.dataset.cdProofCommerce = command.intent.type;
        commerce.dispatch(command);
      },
    },
  };
  const shell = root.querySelector<HTMLElement>("[data-cd-bundle-shell]");
  if (!shell) throw new Error("Storefront proof shell is missing");
  const visualLayer = bundle.visualLayer?.kind === "fragment_shader" ? bundle.visualLayer : undefined;
  const shellHandle = hydrateStorefront({ root: shell, artifact: bundle.shell, adapters, visualLayer });
  const routeRoot = routeId === "checkout"
    ? null
    : root.querySelector<HTMLElement>(`[data-cd-bundle-route='${routeId}']`);
  const routeHandle = routeId === "checkout"
    ? null
    : routeRoot
      ? hydrateStorefront({ root: routeRoot, artifact: bundle.routes[routeId], adapters, visualLayer })
      : null;
  if (!shellHandle.hydrated) throw shellHandle.error ?? new Error("Storefront shell hydration failed");
  if (routeId !== "checkout" && !routeHandle?.hydrated) {
    throw routeHandle?.error ?? new Error("Storefront route hydration failed");
  }
  const checkoutButton = document.querySelector<HTMLButtonElement>("[data-cd-proof-checkout='continue']");
  const checkoutEmail = document.querySelector<HTMLInputElement>("input[name='email']");
  if (routeId === "checkout" && checkoutButton && checkoutEmail) {
    checkoutButton.onclick = () => {
      void proofFetcher("/storefront/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "quote", email: checkoutEmail.value }),
      }).then(refresh);
    };
  }
  return { shellHydrated: shellHandle.hydrated, routeHydrated: routeId === "checkout" || Boolean(routeHandle?.hydrated) };
};
