"""Plan 05 Task 3 — Python-side coverage for the HMAC pseudonym helper.

The reference value ``p_31db4a5edbb70974b004fa2d3dfa1e12`` is also
asserted by ``packages/shared/src/moat/pseudonym.test.ts``. Keeping the
constant in both files (rather than importing from a shared fixture)
gives us a hard cross-language alarm if either side drifts.
"""
from __future__ import annotations

from calderyn_engine.moat.pseudonym import pseudonym_for

REFERENCE = "p_31db4a5edbb70974b004fa2d3dfa1e12"


def test_matches_typescript_output() -> None:
    """Pinned cross-language reference. See pseudonym.test.ts for parity."""

    assert pseudonym_for("shop-uuid-1", "pepper-v1") == REFERENCE


def test_deterministic() -> None:
    """Same inputs collide on the same pseudonym."""

    assert pseudonym_for("shop-a", "pep") == pseudonym_for("shop-a", "pep")


def test_rotation() -> None:
    """Rotating the pepper invalidates old pseudonyms."""

    assert pseudonym_for("shop-a", "v1") != pseudonym_for("shop-a", "v2")


def test_differs_across_shops() -> None:
    """Different shops never collide under the same pepper (modulo HMAC bday)."""

    assert pseudonym_for("shop-a", "pep") != pseudonym_for("shop-b", "pep")
