import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Link } from "react-router";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";

type PolarisRouterLinkProps = Omit<ComponentPropsWithoutRef<"a">, "href"> & {
  /** Polaris passes the destination as `url`. */
  url?: string;
  to?: string;
};

/**
 * Polaris `linkComponent` shim that maps Polaris' `url` prop onto the router
 * `Link`. Extra Polaris link props (e.g. `external`) are spread through as-is
 * and dropped by the anchor, so the new-tab intent is lost — that quirk is
 * characterized in routes/__tests__/dashboard-link-target.test.ts and is why
 * app._index opens the web dashboard via window.open.
 */
function PolarisRouterLink({ url, to, children, ...rest }: PolarisRouterLinkProps) {
  return (
    <Link {...rest} to={url ?? to ?? ""}>
      {children}
    </Link>
  );
}

export interface EmbeddedAppProviderProps {
  /** Include the App Bridge script (requires `apiKey`). */
  embedded?: boolean;
  apiKey?: string;
  children?: ReactNode;
}

/**
 * Admin-surface provider: App Bridge setup from the framework package plus the
 * Polaris React provider (translations + router-aware links) every embedded
 * screen relies on.
 */
export function EmbeddedAppProvider({
  embedded = false,
  apiKey,
  children,
}: EmbeddedAppProviderProps) {
  const bridge =
    embedded && apiKey ? { embedded: true as const, apiKey } : { embedded: false as const };
  return (
    <ShopifyAppProvider {...bridge}>
      <PolarisAppProvider
        i18n={polarisTranslations}
        linkComponent={PolarisRouterLink}
      >
        {children}
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}
