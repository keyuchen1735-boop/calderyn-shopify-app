# apps/engine/tests/unit/test_config_loads.py
"""Plan 03 Task 2: env-driven Config loader."""
from __future__ import annotations

import pytest

from calderyn_engine.config import load_config


def test_load_config_reads_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://x")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-123")
    monkeypatch.setenv("ENGINE_ENV", "test")
    cfg = load_config()
    assert cfg.database_url == "postgres://x"
    assert cfg.anthropic_api_key == "sk-ant-123"
    assert cfg.env == "test"
    assert cfg.claude_model == "claude-opus-4-7"


def test_load_config_requires_database_url(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError):
        load_config()
