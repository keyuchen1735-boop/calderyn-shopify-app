"""Acceptance test conftest — inherits sys.path and DB fixtures from the parent
conftest.py.

test_estimator_determinism.py and test_prompt_injection_acceptance.py are
DB-free. The ported test_spec10_detector_coverage.py is DB-backed via the
parent's pg_pool/seed_* fixtures and skips unless a local TEST_DATABASE_URL is
set.
"""
