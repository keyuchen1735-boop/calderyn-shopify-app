import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  isStorefrontRecipeReviewEnabled,
  isStorefrontRecipeReviewTemplateId,
} from "~/lib/storefront-recipes/review.server";

export function loader({ params }: LoaderFunctionArgs) {
  if (!isStorefrontRecipeReviewEnabled() || !isStorefrontRecipeReviewTemplateId(params.template)) {
    throw new Response("Not found", { status: 404 });
  }
  return redirect(`/dashboard/store/preview?template=${encodeURIComponent(params.template)}`);
}
