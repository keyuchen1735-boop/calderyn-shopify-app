# Engine tests

Two tiers, run by the same command. The split is automatic, keyed on whether a
local test database is configured.

## DB-free tests (always run)

Detector golden-fixture replays, the Claude-layer JSON contract, estimators,
schemas, prompt-injection hardening, moat (mock-connection), and the CLI. No
database needed:

```bash
.venv/bin/python -m pytest tests/engine -q
```

These are the gate the `python` CI job runs even without Postgres.

## DB-backed tests (opt-in via a LOCAL test database)

The per-detector tests, the integration/RLS/threshold/alerts/moat tests, and
`test_db_smoke` exercise each detector's real SQL against Postgres. They need a
database carrying the full engine schema, so they **skip** unless
`TEST_DATABASE_URL` is set to a **local** database.

Spin one up (disposable `postgres:17` in Docker, schema applied from
`tests/engine/schema/`):

```bash
tests/engine/scripts/test-db.sh up          # prints the TEST_DATABASE_URL to use
TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test \
  .venv/bin/python -m pytest tests/engine -q
tests/engine/scripts/test-db.sh down         # tear down when finished
```

CI runs the same set against a `postgres:17` service container (see
`.github/workflows/ci.yml`).

### Safety

The suite reads **only** `TEST_DATABASE_URL` — never `DATABASE_URL` — and
**refuses any non-loopback host** (`tests/engine/conftest.py`). This is
deliberate: the engine package calls `load_dotenv()` at import, which would
otherwise populate `DATABASE_URL` from `.env`/`.env.local` with the shared
Supabase URL. A session-scoped fixture truncates the engine tables before each
DB-backed run so re-runs are hermetic; that truncation can therefore only ever
touch a local database. **Never point `TEST_DATABASE_URL` at a real database.**

## Schema source

`tests/engine/schema/migrations/` is a vendored copy of the engine schema from
the `keyuchen1735-boop/Calderyn-Shopify` monorepo's `supabase/migrations/`,
used only to build the local test database. The monorepo (and Supabase) remain
the source of truth for the deployed schema; these files are test fixtures, not
this repo's deploy migrations (those live in `supabase/migrations/`).
