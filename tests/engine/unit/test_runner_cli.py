"""Plan 03 Task 23: CLI argument parsing for ``calderyn-engine run``."""

from __future__ import annotations

from datetime import date

import pytest

from calderyn_engine.runner import parse_args


def test_run_subcommand_requires_shop() -> None:
    ns = parse_args(["run", "--shop", "00000000-0000-0000-0000-000000000001"])
    assert ns.command == "run"
    assert ns.shop == "00000000-0000-0000-0000-000000000001"
    assert ns.day is None


def test_run_subcommand_accepts_day_iso_date() -> None:
    ns = parse_args(
        [
            "run",
            "--shop",
            "00000000-0000-0000-0000-000000000001",
            "--day",
            "2026-04-19",
        ]
    )
    assert ns.day == date(2026, 4, 19)


def test_missing_shop_argument_errors() -> None:
    # argparse calls SystemExit on a missing required argument; the test
    # is the negative-case sentinel that the CLI surface stays strict.
    with pytest.raises(SystemExit):
        parse_args(["run"])


def test_no_subcommand_errors() -> None:
    with pytest.raises(SystemExit):
        parse_args([])


def test_invalid_day_format_errors() -> None:
    with pytest.raises(SystemExit):
        parse_args(
            [
                "run",
                "--shop",
                "00000000-0000-0000-0000-000000000001",
                "--day",
                "not-a-date",
            ]
        )
