# apps/engine/tests/test_db_smoke.py
"""Smoke test: the engine package and DB module import cleanly.

The earlier psycopg-based smoke test was retired in Plan 03 Task 3 when
``calderyn_engine.db`` was rewritten on top of asyncpg. The
RLS/with_shop_context behaviour is exercised by
``tests/integration/test_with_shop_context.py``.
"""
from __future__ import annotations


def test_engine_package_imports():
    import calderyn_engine
    from calderyn_engine import db, config

    assert hasattr(db, "with_shop_context")
    assert hasattr(db, "make_pool")
    assert hasattr(config, "load_config")
    assert hasattr(calderyn_engine, "__version__")
