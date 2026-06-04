-- Plan 05 Task 17 — moat.incident_library.
--
-- Stores PII-stripped pattern signatures harvested from
-- ``outcome_confirmed`` events. Dormant in v1: rows are only added
-- by the extractor (Task 18) when a merchant confirms a real loss.
-- The detector layer reads this on alert ranking to surface
-- "we've seen this exact pattern resolve into $N loss across N
-- other shops" copy.
--
-- ``pattern_signature`` is a deterministic hash over the alert's
-- evidence keys + detector_id, computed by the extractor. Storing
-- it as ``text`` rather than ``bytea`` keeps the dedupe query
-- (``WHERE pattern_signature = $1``) cheap and indexable.
--
-- ``narrative_template`` is the redacted human copy the engine
-- splices into Claude's narrative. Bounded length is enforced at
-- the extractor's input boundary, not in SQL — this column needs
-- to accept the full rendered string from any detector.
--
-- ``similarity_threshold`` is the cosine-distance / signature-match
-- threshold the extractor uses on the next outcome_confirmed event
-- to decide whether the new pattern is a near-duplicate. Stored
-- per row so individual high-confidence patterns can pin their
-- own threshold without a global setting.

create table moat.incident_library (
  id                   uuid primary key default gen_random_uuid(),
  detector_id          text not null,
  pattern_signature    text not null,
  narrative_template   text not null,
  similarity_threshold numeric(4,3) not null default 0.85,
  created_at           timestamptz not null default now()
);

create index incident_library_detector_signature_idx
  on moat.incident_library (detector_id, pattern_signature);
