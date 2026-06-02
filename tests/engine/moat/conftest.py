"""Moat test conftest — inherits sys.path from the parent conftest.py.

No DB fixtures here. All moat tests in this directory use hand-rolled
mock asyncpg connections and are DB-free.
"""
