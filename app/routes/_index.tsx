import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { resolveTenantShopId } from "~/lib/storefront/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // A store subdomain's homepage IS its storefront: customers landing on
  // shopname.calderyncompany.com expect products, not platform copy. Platform
  // hosts (app., deploy URLs, localhost) go to the dashboard instead — the
  // session gate bounces signed-out visitors to /login. Fail open to the
  // dashboard redirect on a transient lookup error — never 500 a homepage
  // over it.
  const tenant = await resolveTenantShopId(request).catch(() => null);
  if (tenant) throw redirect("/storefront");

  throw redirect("/dashboard");
};
