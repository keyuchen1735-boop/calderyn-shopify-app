"""Spec §10 acceptance tests.

These tests run on the *real* engine surface (registry, estimators,
claude_layer) and stand as the source of truth for the spec §10 matrix
in ``docs/acceptance/spec10-matrix.md``. They are intentionally *not*
networked — Claude is mocked, the database is the test-container
Postgres, and seed data is built in-process.

Plan 07 Tasks 7–9 + 22 keep these tests in the acceptance-gate workflow
on push to ``master``; if any test here fails, the cutover gate is red.
"""
