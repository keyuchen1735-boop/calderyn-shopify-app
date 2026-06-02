"""Plan 07 Task 10 — Claude regression replay package.

Holds the runner that replays a fixed list of detection inputs against
Claude (or a mock during CI) and diffs structured output against
``apps/engine/tests/regression/golden/*.json``. The nightly workflow
``.github/workflows/nightly-claude-regression.yml`` invokes the runner
with the real ANTHROPIC_API_KEY; the smoke test under
``apps/engine/tests/regression/test_replay_smoke.py`` invokes it with
a mock so the CI gate still has a green non-networked fixture.
"""

from calderyn_engine.regression.runner import (
    DEFAULT_FIXTURES,
    GoldenDiff,
    ReplayResult,
    diff_against_golden,
    load_golden,
    run_replay,
)

__all__ = [
    "DEFAULT_FIXTURES",
    "GoldenDiff",
    "ReplayResult",
    "diff_against_golden",
    "load_golden",
    "run_replay",
]
