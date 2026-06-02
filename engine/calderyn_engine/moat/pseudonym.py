"""Plan 05 Task 3 — HMAC-SHA256 pseudonym derivation (Python side).

This is the byte-for-byte equivalent of
``packages/shared/src/moat/pseudonym.ts::pseudonymFor``. Both produce
``"p_" + hex(HMAC_SHA256(pepper, shop_id))[:32]`` so a row written from
the Python engine and a row written from a Node worker collide on the
same pseudonym for the same (shop_id, pepper) pair.

Reference output for ``shop_id="shop-uuid-1", pepper="pepper-v1"`` is
``p_31db4a5edbb70974b004fa2d3dfa1e12``. Both languages produce the same
hex digest (HMAC-SHA256 is fully specified) so a single reference value
exercises both implementations. Do not change the slice length or
algorithm without updating ``pseudonym.ts``, the reference output, and
incrementing ``pepper_version`` in ``moat_keys.shop_pseudonym``.
"""
from __future__ import annotations

import hashlib
import hmac


def pseudonym_for(shop_id: str, pepper: str) -> str:
    """Return the deterministic, irreversible pseudonym for ``shop_id``.

    Parameters
    ----------
    shop_id:
        The ``public.shops.id`` (uuid as string) of the tenant.
    pepper:
        The active pepper string. Rotating the pepper invalidates every
        old pseudonym — make sure to bump ``pepper_version`` in
        ``moat_keys.shop_pseudonym`` at the same time.

    Returns
    -------
    str
        Of the form ``p_[0-9a-f]{32}``.
    """

    digest = hmac.new(
        pepper.encode("utf-8"),
        shop_id.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"p_{digest[:32]}"
