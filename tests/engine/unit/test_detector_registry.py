"""Unit tests for the detector registry.

Covers the three invariants pinned in Plan 03 Task 9:

1. The ``register`` decorator inserts the target into the registry under
   the requested id.
2. Re-registering the same id raises ``ValueError`` instead of silently
   clobbering — duplicate detector ids are a programming error.
3. The registry exposes a snapshot whose mutation does *not* affect the
   underlying store.

Tests run in isolation against a freshly-cleared registry so they can be
re-ordered or run individually without leaking state.
"""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING

import pytest

from calderyn_engine.detectors import (
    DETECTOR_REGISTRY,
    DetectorBase,
    register,
    registered_ids,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    import asyncpg


@pytest.fixture(autouse=True)
def _clear_registry():
    """Snapshot and restore the underlying registry around every test."""

    # The registry is module-private; reach in via the package module so
    # tests don't have to know the implementation detail.
    from calderyn_engine import detectors as pkg

    saved = dict(pkg._REGISTRY)
    pkg._REGISTRY.clear()
    try:
        yield
    finally:
        pkg._REGISTRY.clear()
        pkg._REGISTRY.update(saved)


class _FakeDetector(DetectorBase):
    detector_id = "fake_detector"

    async def detect(
        self,
        conn: asyncpg.Connection,
        shop_id: str,
        day: date,
    ) -> list:
        return []


def test_register_decorator_adds_entry() -> None:
    @register("fake_detector")
    class Target(_FakeDetector):
        detector_id = "fake_detector"

    assert "fake_detector" in DETECTOR_REGISTRY
    assert "fake_detector" in registered_ids()
    instance = DETECTOR_REGISTRY["fake_detector"]
    assert isinstance(instance, _FakeDetector)
    assert instance.detector_id == "fake_detector"


def test_duplicate_detector_id_raises_value_error() -> None:
    @register("dupe_detector")
    class First(_FakeDetector):
        detector_id = "dupe_detector"

    with pytest.raises(ValueError, match="dupe_detector"):

        @register("dupe_detector")
        class Second(_FakeDetector):
            detector_id = "dupe_detector"


def test_snapshot_is_isolated_from_underlying_registry() -> None:
    @register("snapshot_detector")
    class Target(_FakeDetector):
        detector_id = "snapshot_detector"

    snap = DETECTOR_REGISTRY.snapshot()
    assert "snapshot_detector" in snap

    # Mutating the snapshot must not affect the underlying registry.
    snap["snapshot_detector"] = "tampered"  # type: ignore[assignment]
    snap["bogus"] = "tampered"  # type: ignore[assignment]
    del snap["snapshot_detector"]

    # The live registry is untouched.
    assert "snapshot_detector" in DETECTOR_REGISTRY
    assert "bogus" not in DETECTOR_REGISTRY
    assert isinstance(
        DETECTOR_REGISTRY["snapshot_detector"], _FakeDetector
    )


def test_empty_detector_id_is_rejected() -> None:
    with pytest.raises(ValueError):
        register("")


def test_registered_ids_returns_frozenset() -> None:
    @register("frozen_detector")
    class Target(_FakeDetector):
        detector_id = "frozen_detector"

    ids = registered_ids()
    assert isinstance(ids, frozenset)
    assert "frozen_detector" in ids
