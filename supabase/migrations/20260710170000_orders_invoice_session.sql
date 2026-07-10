-- Last-minted hosted session per invoice order: the pay-link route expires it
-- before minting a replacement so a buyer with two tabs cannot complete two
-- payments. A narrow race remains (complete A while B mints); the webhook's
-- already-paid guard surfaces that surplus capture loudly instead of throwing.
alter table public.orders add column if not exists invoice_session_id text;
