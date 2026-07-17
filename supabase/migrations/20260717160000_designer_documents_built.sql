-- Designer first builds save page-by-page; a build interrupted mid-stream
-- (platform kill, network drop) previously left the remaining routes as raw
-- template with no way to tell. `built` marks which routes the build actually
-- designed, so the chat endpoint can resume the remaining ones instead of
-- silently downgrading to single-page edit turns.
-- Existing rows default to true: they predate interruption tracking and are
-- treated as complete sets.
alter table designer_documents
  add column if not exists built boolean not null default true;
