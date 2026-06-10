-- The actions layer (app/lib/actions/execute.server.ts ExecutableKind, the
-- retry executor registry, and undo) all support resume_campaign, but the
-- action_kind enum never gained the value — a live resume mutated the ad
-- platform and then failed to write its audit row (rule-12 violation: effect
-- with no record). Add the missing enum value.
alter type public.action_kind add value if not exists 'resume_campaign';
