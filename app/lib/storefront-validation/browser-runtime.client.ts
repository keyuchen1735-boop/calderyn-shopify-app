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
  const baseAdapters = createRuntimeAdapters({
    mode: "public",
    data,
    fetcher: async (request) => {
      document.documentElement.dataset.cdProofFetch = String(request);
      return new Response(null, { status: 204 });
    },
    refresh() {
      document.documentElement.dataset.cdProofRefresh = "true";
    },
    locationAssign(href) {
      document.documentElement.dataset.cdProofNavigation = href;
    },
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
  const shellHandle = hydrateStorefront({ root: shell, artifact: bundle.shell, adapters });
  const routeRoot = routeId === "checkout"
    ? null
    : root.querySelector<HTMLElement>(`[data-cd-bundle-route='${routeId}']`);
  const routeHandle = routeId === "checkout"
    ? null
    : routeRoot
      ? hydrateStorefront({ root: routeRoot, artifact: bundle.routes[routeId], adapters })
      : null;
  if (!shellHandle.hydrated) throw shellHandle.error ?? new Error("Storefront shell hydration failed");
  if (routeId !== "checkout" && !routeHandle?.hydrated) {
    throw routeHandle?.error ?? new Error("Storefront route hydration failed");
  }
  return { shellHydrated: shellHandle.hydrated, routeHydrated: routeId === "checkout" || Boolean(routeHandle?.hydrated) };
};
