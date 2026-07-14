// app/routes/dashboard.builder.generate.tsx
// Dashboard action that kicks off store generation, then redirects to the read-only draft
// preview (no editor yet — sub-project 2). Validates FormData at the boundary (never trusts it).
import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { requireVerifiedSession } from "~/lib/dashboard/session.server";
import { rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import { quotaTrusted } from "~/lib/ai-quota.server";
import {
  buildStorefrontDesign,
  prepareStorefrontDesignBuild,
  StorefrontBuildError,
} from "~/lib/storefront-bundle/build.server";
import { StorefrontReleaseError } from "~/lib/storefront-bundle/release.server";
import { parseStoreDesignRequest } from "~/lib/storefront-bundle/routing";
import { STORE_TEMPLATE_REGISTRY } from "~/lib/storefront-bundle/registry";
import { CalderynError } from "~/lib/calderyn.server";

export async function action({ request }: ActionFunctionArgs) {
  // Match the dashboard.api.* convention: same-origin (CSRF) + email-verified.
  requireSameOrigin(request);
  const session = await requireVerifiedSession(request);
  const form = await request.formData();
  const mode = form.get("mode");
  if (mode !== "brief" && mode !== "catalog") throw new Response("invalid mode", { status: 400 });
  const briefRaw = form.get("brief");
  const rawBrief = typeof briefRaw === "string" ? briefRaw : undefined;
  const parsed = parseStoreDesignRequest({
    mode: "auto",
    prompt: mode === "brief" ? rawBrief ?? "" : "",
  }, STORE_TEMPLATE_REGISTRY);
  if (!parsed.ok) throw new Response("invalid brief", { status: 422 });
  if (!(await rateLimit(`storefront-build:${session.shopId}`, 10, 60_000))) {
    throw new Response("Too many storefront builds. Please wait a moment.", { status: 429 });
  }
  try {
    // Freeze runtime switches, experiment/write guards, release pointers and —
    // only for an explicit custom resolution — the paid generation quota before
    // any bundle or asset mutation.
    const prepared = await prepareStorefrontDesignBuild({
      shopId: session.shopId,
      request: parsed.value,
      trusted: quotaTrusted(session),
    });
    await buildStorefrontDesign({
      shopId: session.shopId,
      actorId: session.userId,
      request: parsed.value,
      trusted: quotaTrusted(session),
      prepared,
    });
  } catch (err) {
    if (err instanceof StorefrontBuildError || err instanceof StorefrontReleaseError || err instanceof CalderynError) {
      throw new Response(err.message, { status: err.status });
    }
    throw err;
  }
  return redirect("/dashboard/store/preview?route=home");
}
