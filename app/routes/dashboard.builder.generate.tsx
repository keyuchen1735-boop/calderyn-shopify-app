// app/routes/dashboard.builder.generate.tsx
// Dashboard action that kicks off store generation, then redirects to the read-only draft
// preview (no editor yet — sub-project 2). Validates FormData at the boundary (never trusts it).
import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { requireVerifiedSession } from "~/lib/dashboard/session.server";
import { requireSameOrigin } from "~/lib/dashboard/http.server";
import { generateStore } from "~/lib/storegen/generate.server";

export async function action({ request }: ActionFunctionArgs) {
  // Match the dashboard.api.* convention: same-origin (CSRF) + email-verified.
  requireSameOrigin(request);
  const session = await requireVerifiedSession(request);
  const form = await request.formData();
  const mode = form.get("mode");
  if (mode !== "brief" && mode !== "catalog") throw new Response("invalid mode", { status: 400 });
  const briefRaw = form.get("brief");
  const brief = typeof briefRaw === "string" && briefRaw.trim() ? briefRaw.trim() : undefined;
  await generateStore({ shopId: session.shopId, mode, brief });
  return redirect("/dashboard/builder/preview");
}
