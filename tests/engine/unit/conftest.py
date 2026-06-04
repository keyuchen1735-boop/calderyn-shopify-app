"""Unit test conftest — inherits sys.path and DB fixtures from the parent
conftest.py.

Most tests here are DB-free, but the per-detector tests (test_detector_*.py)
are DB-backed via the parent's pg_pool/seed_* fixtures and skip unless a local
TEST_DATABASE_URL is set.
"""
