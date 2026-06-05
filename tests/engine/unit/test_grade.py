"""Unit tests for the campaign grade math (Decimal rule math)."""

from decimal import Decimal

from calderyn_engine.grade import (
    COVERAGE_THRESHOLD,
    DEFAULT_MARGIN,
    GRADE_OK_FACTOR,
    GRADE_WIN_FACTOR,
    break_even_roas,
    derive_margin,
    grade_campaign,
)


def test_constants_match_source() -> None:
    assert GRADE_WIN_FACTOR == Decimal("1.2")
    assert GRADE_OK_FACTOR == Decimal("0.95")
    assert DEFAULT_MARGIN == Decimal("0.4")
    assert COVERAGE_THRESHOLD == Decimal("0.7")


def test_grade_winning_at_or_above_120pct_breakeven() -> None:
    assert grade_campaign(Decimal("3.0"), Decimal("2.5")) == "winning"
    assert grade_campaign(Decimal("2.99"), Decimal("2.5")) == "okay"


def test_grade_okay_between_95pct_and_120pct() -> None:
    assert grade_campaign(Decimal("2.375"), Decimal("2.5")) == "okay"
    assert grade_campaign(Decimal("2.374"), Decimal("2.5")) == "poor"


def test_grade_poor_below_95pct() -> None:
    assert grade_campaign(Decimal("1.0"), Decimal("2.5")) == "poor"


def test_grade_breakeven_nonpositive_edge() -> None:
    assert grade_campaign(Decimal("0.1"), Decimal("0")) == "winning"
    assert grade_campaign(Decimal("0"), Decimal("0")) == "poor"


def test_break_even_roas_is_reciprocal_of_margin() -> None:
    assert break_even_roas(Decimal("0.4")) == Decimal("2.5")


def test_derive_margin_uses_computed_when_coverage_sufficient() -> None:
    margin, conf = derive_margin(
        revenue_known=Decimal("1000"),
        cogs_known=Decimal("600"),
        coverage=Decimal("0.8"),
    )
    assert margin == Decimal("0.4")
    assert conf == "ok"


def test_derive_margin_falls_back_when_coverage_low() -> None:
    margin, conf = derive_margin(
        revenue_known=Decimal("1000"),
        cogs_known=Decimal("600"),
        coverage=Decimal("0.5"),
    )
    assert margin == DEFAULT_MARGIN
    assert conf == "default"


def test_derive_margin_falls_back_when_no_known_revenue() -> None:
    margin, conf = derive_margin(
        revenue_known=Decimal("0"),
        cogs_known=Decimal("0"),
        coverage=Decimal("0"),
    )
    assert margin == DEFAULT_MARGIN
    assert conf == "default"


def test_derive_margin_falls_back_when_margin_nonpositive() -> None:
    margin, conf = derive_margin(
        revenue_known=Decimal("1000"),
        cogs_known=Decimal("1000"),
        coverage=Decimal("0.9"),
    )
    assert margin == DEFAULT_MARGIN
    assert conf == "default"
