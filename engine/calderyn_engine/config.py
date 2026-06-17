# apps/engine/calderyn_engine/config.py
"""Engine configuration loaded from environment.

Plan 03 Task 2: frozen dataclass Config + load_config() that requires DATABASE_URL.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Config:
    database_url: str
    anthropic_api_key: str
    env: str
    claude_model: str


def load_config() -> Config:
    db = os.environ.get("DATABASE_URL")
    if not db:
        raise RuntimeError("DATABASE_URL is required")
    return Config(
        database_url=db,
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        env=os.environ.get("ENGINE_ENV", "dev"),
        claude_model=os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6"),
    )
