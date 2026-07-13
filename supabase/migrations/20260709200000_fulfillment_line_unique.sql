-- Defense-in-depth for the fulfillment-line over-coverage guard (executeFulfillAction already
-- rejects a duplicate orderLineId within one request and decrements a working `remaining` copy as
-- lines are accepted). One fulfillment may cover a given order line at most once -- a second
-- coverage row for the same (fulfillment_id, order_line_id) pair would double-count that line's
-- quantity against `remaining` on any future read, so the app-layer guard is backed by a unique
-- index rather than trusted alone.
create unique index if not exists fulfillment_line_unique_line
  on public.fulfillment_line (fulfillment_id, order_line_id);
