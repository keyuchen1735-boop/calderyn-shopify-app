// TEMP diagnostic — standalone Vercel function (registered in vercel.json so it
// is its own lambda, independent of the Remix server). Returns only the LENGTH
// of each env var, never the value, to show which reach the lambda empty.
export default function handler(req, res) {
  const L = (k) => (process.env[k] || "").length;
  res.setHeader("content-type", "application/json");
  res.status(200).end(
    JSON.stringify({
      env: process.env.VERCEL_ENV || "?",
      // sensitive-type vars (suspected empty)
      SHOPIFY_API_KEY: L("SHOPIFY_API_KEY"),
      SHOPIFY_API_SECRET: L("SHOPIFY_API_SECRET"),
      SCOPES: L("SCOPES"),
      DATABASE_URL: L("DATABASE_URL"),
      SUPABASE_URL: L("SUPABASE_URL"),
      SUPABASE_SERVICE_ROLE_KEY: L("SUPABASE_SERVICE_ROLE_KEY"),
      // encrypted-type vars (suspected present) + my restored one
      ANTHROPIC_API_KEY: L("ANTHROPIC_API_KEY"),
      CRON_SECRET: L("CRON_SECRET"),
      SHOPIFY_APP_URL: L("SHOPIFY_APP_URL"),
    }),
  );
}
