"""Detector protocol and helper base class.

A *detector* is a coroutine that, given a shop and a calendar day, reads
normalized facts from the merchant database and returns zero or more
``DetectionResult`` objects describing alert candidates. Detectors must not
write to the database directly — the engine pipeline persists alerts via
``alerts_repo`` after enrichment with Claude narrative + ranking.

Two shapes are supported:

* Anything that satisfies the ``Detector`` ``Protocol`` — a class with a
  ``detector_id`` class attribute and an ``async def detect(...)`` method.
* A subclass of ``DetectorBase`` for the common case where the detector_id
  is fixed at construction time.

Both shapes are registered through the ``register`` decorator in
``calderyn_engine.detectors`` so the runtime can iterate the full set.
"""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:  # pragma: no cover - import-time only for type checkers
    import asyncpg

    from calderyn_engine.schemas import DetectionResult


@runtime_checkable
class Detector(Protocol):
    """Structural type every detector must satisfy.

    Implementations expose a stable string ``detector_id`` (matching the
    enum used in the ``alerts`` table) and an async ``detect`` method. The
    detector is given a database connection that has already had
    ``app.shop_id`` set via ``with_shop_context`` — RLS will scope every
    query to the right tenant automatically.
    """

    detector_id: str

    async def detect(
        self,
        conn: asyncpg.Connection,
        shop_id: str,
        day: date,
    ) -> list[DetectionResult]:
        ...


class DetectorBase:
    """Concrete base class detectors typically inherit from.

    Subclasses either set ``detector_id`` as a class attribute or pass it to
    ``super().__init__``. The registry decorator validates the id matches
    so a typo is caught at import time, not at runtime.
    """

    detector_id: str

    def __init__(self, detector_id: str | None = None) -> None:
        if detector_id is not None:
            self.detector_id = detector_id
        if not getattr(self, "detector_id", None):
            raise ValueError(
                "DetectorBase subclasses must set a non-empty detector_id"
            )

    async def detect(
        self,
        conn: asyncpg.Connection,
        shop_id: str,
        day: date,
    ) -> list[DetectionResult]:  # pragma: no cover - abstract
        raise NotImplementedError(
            f"{type(self).__name__}.detect must be overridden"
        )
