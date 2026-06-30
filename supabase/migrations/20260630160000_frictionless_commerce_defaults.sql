-- Frictionless agentic commerce: commerce is ON by default for connected AI clients; the
-- per-client disable/cap remains an OPTIONAL merchant override. spend_cap_cents = 0 means
-- UNLIMITED (no ceiling) — enforced only when a merchant sets a positive value. Payment via
-- Stripe is still always required; this governs only the cap/scope friction.
alter table public.mcp_oauth_clients alter column commerce_scope set default true;
-- Enable commerce on already-registered clients (they predate this default).
update public.mcp_oauth_clients set commerce_scope = true where commerce_scope = false;
