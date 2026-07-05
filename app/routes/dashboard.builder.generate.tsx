// app/routes/dashboard.builder.generate.tsx
// Dashboard action that kicks off store generation, then redirects to the read-only draft
// preview (no editor yet — sub-project 2). Validates FormData at the boundary (never trusts it).
import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { requireVerifiedSession } from "~/lib/dashboard/session.server";
import { requireSameOrigin } from "~/lib/dashboard/http.server";
import { generateStore } from "~/lib/storegen/generate.server";
import { assertCanGenerate } from "~/lib/storegen/guard.server";
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
  try {
    // Rate limit, brief cap and mid-test refusal shared with
    // /dashboard/api/store's generate action (guard.server.ts) — one shop
    // gets 5 paid generation runs a minute across both entry points.
    await assertCanGenerate(session.shopId, rawBrief);
  } catch (err) {
    if (err instanceof CalderynError) throw new Response(err.message, { status: err.status });
    throw err;
  }
  const brief = rawBrief && rawBrief.trim() ? rawBrief.trim() : undefined;
  await generateStore({ shopId: session.shopId, mode, brief });
  return redirect("/dashboard/builder/preview");
}
