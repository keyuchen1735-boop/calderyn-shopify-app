"""Moat test conftest — inherits sys.path and DB fixtures from the parent
conftest.py.

The original moat tests use hand-rolled mock asyncpg connections and are
DB-free. The ported test_consent_purge.py and test_peer_baselines.py are
DB-backed via the parent's pg_pool fixture and skip unless a local
TEST_DATABASE_URL is set.
"""
