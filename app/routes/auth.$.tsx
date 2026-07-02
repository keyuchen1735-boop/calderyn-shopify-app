/*
 * The $ in the filename catches any unhandled path under /auth/, including the
 * OAuth callback redirect Shopify sends after install. shopifyApp.authenticate
 * handles all of these automatically — we just need to call it.
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};
