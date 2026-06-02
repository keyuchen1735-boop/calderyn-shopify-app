"""Plan 05 — moat (cross-tenant learning) layer.

Sub-modules:

* ``pseudonym`` — HMAC-SHA256 derivation of an irreversible pseudonym
  per (shop_id, pepper). Mirrors ``packages/shared/src/moat/pseudonym.ts``.
* ``events``    — pydantic models for every ``moat.event_kind`` payload.
* ``emitter``   — async helper that writes a row into ``moat.event_log``.

Plan 05 Phase A only ships the schema, the helpers, and the engine-side
emitter wiring. The trainer + peer-baseline ETL ship in Phase B; the
role-grant migration that protects ``moat_keys.shop_pseudonym`` ships
in Phase C.
"""
