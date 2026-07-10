-- Concurrent different-key reductions of the same line both observe the same
-- current effective quantity and would both insert an edit row against it,
-- each triggering its own refund (a real overpayment). old_quantity strictly
-- decreases along a line's edit chain (new < old is a table check), so a
-- repeat of (line, old_quantity) can only be a concurrent duplicate: reject it
-- at the database and let the loser re-read and re-validate.
create unique index if not exists order_line_edit_baseline
  on public.order_line_edit (shop_id, order_line_id, old_quantity);
