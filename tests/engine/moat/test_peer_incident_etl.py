"""Slice #5 — peer + incident ETL tests. DB-backed tests use the parent
pg_pool fixture and skip unless TEST_DATABASE_URL points at a local pg."""

from __future__ import annotations

import json
import uuid
from datetime import date
from decimal import Decimal

import pytest

from calderyn_engine.moat.peer_incident_etl import segment_for_shop
from calderyn_engine.moat.pseudonym import pseudonym_for

PEPPER = "pepper-test-slice5"
DETECTOR = "ad_tax_overload"


def test_segment_for_shop_band_thresholds():
    assert segment_for_shop(0) == "gmv:micro"
    assert segment_for_shop(9_999_99) == "gmv:micro"          # $9,999.99
    assert segment_for_shop(10_000_00) == "gmv:small"         # $10,000.00
    assert segment_for_shop(49_999_99) == "gmv:small"
    assert segment_for_shop(50_000_00) == "gmv:mid"
    assert segment_for_shop(249_999_99) == "gmv:mid"
    assert segment_for_shop(250_000_00) == "gmv:large"
    assert segment_for_shop(999_999_99) == "gmv:large"
    assert segment_for_shop(1_000_000_00) == "gmv:xl"
    assert segment_for_shop(5_000_000_00) == "gmv:xl"
