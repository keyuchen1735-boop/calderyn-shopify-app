// TEMP diagnostic — standalone Vercel function (independent of the Remix server,
// so it runs even when shopify.server crashes at init). Returns only the LENGTH
// of each prod secret, never the value, so we can see which env vars reach the
// lambda empty. Remove after the env investigation.
export default function handler(req, res) {
  const L = (k) => (process.env[k] || "").length;
  res.setHeader("content-type", "application/json");
  res.status(200).end(
    JSON.stringify({
      env: process.env.VERCEL_ENV || "?",
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7),
      SHOPIFY_APP_URL: L("SHOPIFY_APP_URL"),
      SHOPIFY_API_KEY: L("SHOPIFY_API_KEY"),
      SHOPIFY_API_SECRET: L("SHOPIFY_API_SECRET"),
      SCOPES: L("SCOPES"),
      DATABASE_URL: L("DATABASE_URL"),
      SUPABASE_URL: L("SUPABASE_URL"),
      SUPABASE_SERVICE_ROLE_KEY: L("SUPABASE_SERVICE_ROLE_KEY"),
    }),
  );
}
