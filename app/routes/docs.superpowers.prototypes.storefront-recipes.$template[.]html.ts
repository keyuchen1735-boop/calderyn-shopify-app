import type { LoaderFunctionArgs } from "@remix-run/node";
import atelier from "../../docs/superpowers/prototypes/storefront-recipes/atelier.html?raw";
import ember from "../../docs/superpowers/prototypes/storefront-recipes/ember.html?raw";
import fizz from "../../docs/superpowers/prototypes/storefront-recipes/fizz.html?raw";
import forge from "../../docs/superpowers/prototypes/storefront-recipes/forge.html?raw";
import gilt from "../../docs/superpowers/prototypes/storefront-recipes/gilt.html?raw";
import glow from "../../docs/superpowers/prototypes/storefront-recipes/glow.html?raw";
import haven from "../../docs/superpowers/prototypes/storefront-recipes/haven.html?raw";
import roast from "../../docs/superpowers/prototypes/storefront-recipes/roast.html?raw";
import volt from "../../docs/superpowers/prototypes/storefront-recipes/volt.html?raw";

const prototypes: Record<string, string> = { atelier, ember, fizz, forge, gilt, glow, haven, roast, volt };

export function loader({ params }: LoaderFunctionArgs) {
  if (process.env.VERCEL_ENV === "production") throw new Response("Not found", { status: 404 });
  if (!params.template || !Object.hasOwn(prototypes, params.template)) throw new Response("Not found", { status: 404 });
  const html = prototypes[params.template];
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
}
