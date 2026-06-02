"""Module entry point so ``python -m calderyn_engine ...`` works.

Defers to :func:`calderyn_engine.runner.main`, which owns the argparse
surface and the asyncio loop.
"""

from __future__ import annotations

from calderyn_engine.runner import main

if __name__ == "__main__":
    raise SystemExit(main())
