import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";

// The Live Engine is now the home page. This legacy route redirects to it,
// preserving shop/host/embedded params so the embedded document request can
// re-authenticate on the bounce.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  throw redirect(`/app${new URL(request.url).search}`);
};
