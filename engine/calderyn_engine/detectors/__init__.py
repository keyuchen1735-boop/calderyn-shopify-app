"""Detector registry.

Detectors register themselves at import time via the ``@register("…")``
decorator. The registry starts empty — Phase B of Plan 03 (Tasks 10–21)
adds one detector per task, and the engine runtime imports those modules
to populate the table.

Two public surfaces:

* ``DETECTOR_REGISTRY`` is a *snapshot* of the current registry. Mutating
  the returned dict does **not** affect the underlying table; this prevents
  test fixtures or accidental writes from corrupting the global state.
* ``register(detector_id)`` is a decorator that inserts a detector into the
  underlying table. Re-registering the same id raises ``ValueError`` so a
  duplicate import or a copy-paste bug surfaces immediately.

Use :func:`registered_ids` for cheap membership checks without copying.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, TypeVar
from collections.abc import Callable

from calderyn_engine.detectors.base import Detector, DetectorBase

if TYPE_CHECKING:  # pragma: no cover - typing only
    pass


# Module-private store. Tests poke this through the public API; do not
# import ``_REGISTRY`` directly from outside the package.
_REGISTRY: dict[str, Detector] = {}

T = TypeVar("T", bound=Detector)


def register(detector_id: str) -> Callable[[type[T] | T], type[T] | T]:
    """Register a detector under ``detector_id``.

    The decorator accepts either a detector *instance* or a detector *class*.
    When given a class, it instantiates it with no arguments — sufficient
    for ``DetectorBase`` subclasses that hard-code their id. When given an
    instance (e.g. a function-based detector wrapped in a small adapter),
    it stores the instance directly.

    Raises
    ------
    ValueError
        If ``detector_id`` is empty, or if another detector has already
        registered the same id. Re-registration is treated as a programming
        error — Phase B detectors all have unique ids.
    """

    if not detector_id:
        raise ValueError("detector_id must be a non-empty string")

    def _wrap(target: type[T] | T) -> type[T] | T:
        if detector_id in _REGISTRY:
            raise ValueError(
                f"Detector already registered for id {detector_id!r}: "
                f"{_REGISTRY[detector_id]!r}"
            )
        instance: Detector
        if isinstance(target, type):
            instance = target()  # type: ignore[call-arg]
        else:
            instance = target
        # Belt-and-braces: keep the registered id consistent with the
        # decorator argument so downstream code never has to reconcile two
        # sources of truth.
        try:
            instance.detector_id = detector_id  # type: ignore[misc]
        except AttributeError:
            # Frozen dataclasses or slotted classes may forbid setattr;
            # fall through and trust the class-level value.
            pass
        _REGISTRY[detector_id] = instance
        return target

    return _wrap


def registered_ids() -> frozenset[str]:
    """Return an immutable snapshot of all currently-registered detector ids."""

    return frozenset(_REGISTRY)


class _RegistrySnapshot(dict):
    """Dict subclass returned by ``DETECTOR_REGISTRY`` access.

    A plain ``dict(...)`` copy is sufficient because mutating the copy
    cannot reach back into ``_REGISTRY``. The subclass exists only so
    callers can ``isinstance``-check the snapshot in tests.
    """


def _snapshot() -> _RegistrySnapshot:
    return _RegistrySnapshot(_REGISTRY)


class _DetectorRegistryProxy:
    """Proxy exposed as ``DETECTOR_REGISTRY``.

    Behaves like a read-only mapping over the live ``_REGISTRY`` for
    membership tests and lookups, and yields fresh copies on iteration so
    callers cannot accidentally mutate the underlying registry.
    """

    def __getitem__(self, key: str) -> Detector:
        return _REGISTRY[key]

    def __contains__(self, key: object) -> bool:
        return key in _REGISTRY

    def __iter__(self):
        # Iterate over a copy so deletion during iteration is safe.
        return iter(list(_REGISTRY))

    def __len__(self) -> int:
        return len(_REGISTRY)

    def get(self, key: str, default: Detector | None = None) -> Detector | None:
        return _REGISTRY.get(key, default)

    def keys(self):
        return list(_REGISTRY.keys())

    def values(self):
        return list(_REGISTRY.values())

    def items(self):
        return list(_REGISTRY.items())

    def snapshot(self) -> _RegistrySnapshot:
        """Return a detached ``dict`` copy of the registry."""

        return _snapshot()

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return f"DETECTOR_REGISTRY({list(_REGISTRY)!r})"


DETECTOR_REGISTRY = _DetectorRegistryProxy()


__all__ = [
    "DETECTOR_REGISTRY",
    "Detector",
    "DetectorBase",
    "register",
    "registered_ids",
]
