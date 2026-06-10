# apps/engine/calderyn_engine/db.py
"""Async DB pool + RLS-scoped transaction helper.

Plan 03 Task 3: replaces the prior psycopg-based connect() with an asyncpg
pool. ``with_shop_context`` opens a transaction and calls
``set_current_shop_id`` (provided by migration 20260419000005) so every read
is RLS-scoped to one shop. Exiting the context commits/rolls back the
transaction, which automatically unbinds the transaction-scoped GUC.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

import asyncpg

_pool: asyncpg.Pool | None = None
_pool_lock = asyncio.Lock()


async def get_pool(
    database_url: str,
    *,
    min_size: int = 1,
    max_size: int = 10,
) -> asyncpg.Pool:
    """Lazy-initialise and return a process-wide asyncpg pool.

    Guarded by a module-level asyncio.Lock so two concurrent first callers
    cannot both create_pool and silently orphan one of the resulting pools.
    """
    global _pool
    if _pool is not None:
        return _pool
    async with _pool_lock:
        if _pool is None:
            # statement_cache_size=0: DATABASE_URL points at Supabase's
            # transaction pooler (port 6543), which does not support asyncpg's
            # named prepared statements across pooled connections.
            _pool = await asyncpg.create_pool(
                database_url,
                min_size=min_size,
                max_size=max_size,
                statement_cache_size=0,
            )
    return _pool


async def make_pool(
    database_url: str,
    *,
    min_size: int = 1,
    max_size: int = 8,
) -> asyncpg.Pool:
    """Create a fresh pool (does not touch the module-level cache)."""
    return await asyncpg.create_pool(
        database_url,
        min_size=min_size,
        max_size=max_size,
        statement_cache_size=0,
    )


@asynccontextmanager
async def with_shop_context(
    conn: asyncpg.Connection, shop_id: str
) -> AsyncIterator[asyncpg.Connection]:
    """Run a block under RLS scoped to ``shop_id``.

    Opens an asyncpg transaction and binds ``app.shop_id`` *transaction-locally*
    (third arg to ``set_config`` is ``true``) so the GUC is automatically
    cleared when the transaction commits or rolls back. The public.current_shop_id()
    function added in migration 20260419000005 reads the same GUC, so RLS
    policies that compare against ``current_shop_id()`` will scope correctly.

    Note: we deliberately do **not** call ``public.set_current_shop_id($1)``
    here, because that helper uses ``set_config(.., false)`` (session scope)
    and would leak the binding across pooled-connection reuses; the
    transaction-local form is what the engine needs.
    """
    tx = conn.transaction()
    await tx.start()
    try:
        await conn.execute("SELECT set_config('app.shop_id', $1, true)", shop_id)
        yield conn
    except Exception:
        await tx.rollback()
        raise
    else:
        await tx.commit()
