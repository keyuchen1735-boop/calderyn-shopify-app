"""CLI entry point for the engine.

Plan 03 Task 23. ``python -m calderyn_engine run --shop <id> [--day YYYY-MM-DD]``
drives :func:`calderyn_engine.pipeline.run_for_shop` and prints the list
of upserted alert ids. The command exits non-zero when the pipeline
raises so an orchestrator (cron, Render job, kubectl exec, etc.) can
detect failure.

The CLI uses argparse so the help text and parsing live in one place.
``parse_args`` is exposed for tests that want to validate the surface
without spinning up the asyncio loop.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import date
from collections.abc import Sequence

import structlog

from calderyn_engine.pipeline import run_for_shop

logger = structlog.get_logger()


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Build the CLI parser and apply it to ``argv``.

    The ``run`` subcommand requires ``--shop`` and accepts an optional
    ``--day YYYY-MM-DD`` to override the day_bucket. Any other sub-command
    is reserved for future use; today only ``run`` is wired up.
    """
    parser = argparse.ArgumentParser(prog="calderyn-engine")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="Run all detectors for one shop.")
    run.add_argument(
        "--shop", required=True, help="Shop UUID to scope the run to."
    )
    run.add_argument(
        "--day",
        type=date.fromisoformat,
        default=None,
        help="Day bucket (YYYY-MM-DD). Defaults to UTC today.",
    )

    return parser.parse_args(argv)


async def _run(shop_id: str, day: date | None) -> list[str]:
    """Run the pipeline once and return the upserted alert ids."""
    return await run_for_shop(shop_id, day=day)


def main(argv: Sequence[str] | None = None) -> int:
    """Synchronous entry point. Returns the process exit code."""
    ns = parse_args(argv if argv is not None else sys.argv[1:])
    if ns.command == "run":
        try:
            ids = asyncio.run(_run(ns.shop, ns.day))
        except Exception as exc:  # noqa: BLE001 — surfaces all failures to ops
            logger.error(
                "engine_run_failed",
                shop_id=ns.shop,
                error=str(exc),
                exc_type=type(exc).__name__,
            )
            print(f"engine run failed: {exc}", file=sys.stderr)
            return 1
        # Stdout is reserved for machine-readable output; stderr carries
        # human-readable progress so a caller can pipe one without the
        # other.
        print(f"upserted {len(ids)} alert(s)", file=sys.stderr)
        for alert_id in ids:
            print(alert_id)
        return 0
    return 2  # unknown subcommand — argparse should have caught it


if __name__ == "__main__":  # pragma: no cover - exercised via -m
    raise SystemExit(main())
