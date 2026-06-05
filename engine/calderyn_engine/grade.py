"""Campaign performance grade — Decimal rule math.

CLAUDE.md invariant #3: all dollar/rule math lives here, in Decimal. The
caller (campaign_grade_repo) supplies pre-aggregated cents from SQL; this
module owns the ratio + classification logic and nothing else.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Literal

Grade = Literal["winning", "okay", "poor"]
Confidence = Literal["override", "ok", "default"]

GRADE_WIN_FACTOR = Decimal("1.2")
GRADE_OK_FACTOR = Decimal("0.95")
DEFAULT_MARGIN = Decimal("0.4")
COVERAGE_THRESHOLD = Decimal("0.7")

ZERO = Decimal("0")
ONE = Decimal("1")


def grade_campaign(roas: Decimal, break_even: Decimal) -> Grade:
    """Classify a campaign by how its ROAS compares to its break-even ROAS."""
    if break_even <= ZERO:
        return "winning" if roas > ZERO else "poor"
    if roas >= GRADE_WIN_FACTOR * break_even:
        return "winning"
    if roas >= GRADE_OK_FACTOR * break_even:
        return "okay"
    return "poor"


def break_even_roas(margin: Decimal) -> Decimal:
    """1 / margin. Caller guarantees margin > 0 (derive_margin enforces it)."""
    return ONE / margin


def derive_margin(
    revenue_known: Decimal,
    cogs_known: Decimal,
    coverage: Decimal,
    override: Decimal | None = None,
) -> tuple[Decimal, Confidence]:
    """Select the contribution margin for a campaign.

    * A valid override (0 < x < 1) wins -> confidence 'override'.
    * Else, when coverage >= 0.7 and known revenue > 0 and the computed
      margin > 0, use the computed margin -> 'ok'.
    * Otherwise fall back to DEFAULT_MARGIN -> 'default'.
    """
    if override is not None and ZERO < override < ONE:
        return override, "override"
    if coverage >= COVERAGE_THRESHOLD and revenue_known > ZERO:
        margin = ONE - (cogs_known / revenue_known)
        if margin > ZERO:
            return margin, "ok"
    return DEFAULT_MARGIN, "default"
