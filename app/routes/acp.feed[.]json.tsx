// ACP product feed. Dormant unless ACP_ENABLED=true. The shop is resolved from a signed feed
// key issued at onboarding (one feed URL per merchant); confirm the key→shop resolution
// mechanism against the onboarded ACP spec (path param vs query token vs signed JWT).
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getAgenticCatalog } from "~/lib/commerce/catalog.server";
import { toAcpFeedItem } from "~/lib/commerce/acp/map";

export async function loader({ request }: LoaderFunctionArgs) {
  if (process.env.ACP_ENABLED !== "true") return json({ error: "acp_disabled" }, { status: 404 });
  const shopId = resolveShopFromFeedKey(new URL(request.url));
  if (!shopId) return json({ error: "unknown_feed" }, { status: 404 });
  const items = (await getAgenticCatalog(shopId)).map(toAcpFeedItem);
  return json({ items });
}

// TODO-REPLACE before ACP onboarding: resolve the per-merchant feed key (?key=...) to the
// shop_id uuid via the registry (a feed_key column on shops or mcp_oauth_clients, or reuse
// resolveShopId). The placeholder returns the key verbatim — UNREACHABLE while ACP_ENABLED
// is false, but must be replaced before onboarding so production never runs this stub.
function resolveShopFromFeedKey(url: URL): string | null {
  const key = url.searchParams.get("key");
  return key ? key : null; // TODO-REPLACE: resolve key -> shop_id uuid via the registry
}
