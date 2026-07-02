// Tenant-isolation disposition manifest for Step 10 RLS hardening.
//
// Single source of truth for which of the 49 previously-policy-free public
// tables receive a shop-scope RLS policy versus stay deny-all by design.
// This mirrors, and is asserted against, supabase/migrations/
// 20260702120000_tenant_isolation_hardening.sql. Any table added to the
// database later must be classified here (and in that migration's coverage
// self-test) or the security posture drifts silently.

/** Group P: tenant-data tables that get `using (shop_id = current_shop_id())`. */
export const SHOP_SCOPE_POLICY_TABLES: string[] = [
  "autopilot_run_lock",
  "bug_report",
  "campaign_direction_reason",
  "collection_dim",
  "creative_screen_run",
  "cutover_transition",
  "image_gen_event",
  "import_map",
  "ingestion_dlq",
  "inventory_balance",
  "inventory_ledger",
  "inventory_reservation",
  "inventory_transfer",
  "product_dim",
  "raw_google_poll",
  "raw_meta_poll",
  "raw_owned_event",
  "raw_quickbooks_poll",
  "shipping_cost_period",
  "shipping_invoice_line",
  "shop_settings",
  "variant_dim",
];

/** Group F: catalog children scoped via a shop_id-bearing ancestor. */
export const FK_CHILD_POLICY_TABLES: {
  table: string;
  parent: string;
  fk: string;
  parentKey: string;
}[] = [
  { table: "product_option", parent: "product_dim", fk: "product_id", parentKey: "id" },
  { table: "product_media", parent: "product_dim", fk: "product_id", parentKey: "id" },
  { table: "product_collection", parent: "product_dim", fk: "product_id", parentKey: "id" },
  { table: "variant_option_value", parent: "variant_dim", fk: "variant_id", parentKey: "id" },
  // product_option_value reaches shop_id via product_option -> product_dim.
  { table: "product_option_value", parent: "product_option", fk: "option_id", parentKey: "id" },
];

/** Group D: secret/auth-material and global tables that stay deny-all (no policy). */
export const DENY_ALL_TABLES: string[] = [
  // secret/auth material with shop_id
  "integration_credentials",
  "mcp_oauth_codes",
  "mcp_tokens",
  "oauth_state",
  "dashboard_sessions",
  "membership",
  // global / auth / marketing, no shop_id
  "admin_access_log",
  "app_secret",
  "email_optouts",
  "linkedin_connection",
  "mcp_oauth_clients",
  "mcp_pending_oauth",
  "password_reset_token",
  "pilot_invites",
  "rate_limit_hits",
  "shopify_sessions",
  "shopify_sessions_migrations",
  "social_digest",
  "social_link_post",
  "users",
  "waitlist",
  "waitlist_rate_limit",
];

export const NO_POLICY_TABLE_COUNT = 49;
