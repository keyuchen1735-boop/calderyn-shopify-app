-- Per-platform approval for social_digest: LinkedIn and Instagram are now
-- approved independently (dedicated buttons), so each gets its own single-use
-- timestamp. li_posted_at = LinkedIn auto-posted; ig_approved_at = Instagram
-- assets handed off for manual posting. Regeneration resets both to null.

alter table public.social_digest
  add column if not exists li_posted_at   timestamptz,
  add column if not exists ig_approved_at timestamptz;