import json
from decimal import Decimal
from pathlib import Path

from backend.services.importer import normalize, plan_import
from backend.services.pricing import DEFAULT_MARKUPS as M

ROW = {"status": "in_stock", "name": "Apple Peach", "brand": "ElfLiq", "category": "liquid", "volume_ml": 30,
       "nicotine_mg": 50, "purchase_price_uah": "240.0", "dedupe_key": "k1"}


def test_normalize_applies_markup_once():
    d = normalize(ROW, M)
    assert d["purchase_price"] == Decimal("240.00") and d["final_price"] == Decimal("250.00")


def test_usdt_source_rounded_up():
    d = normalize({**ROW, "category": "pod", "purchase_price_usdt": "18", "usdt_rate": "45.1",
                   "purchase_price_uah": "812", "dedupe_key": "k2"}, M)
    assert d["purchase_price"] == Decimal("812.00") and d["final_price"] == Decimal("882.00")
    assert d["usdt"]["rate"] == Decimal("45.1")


def test_unavailable_skipped_and_errors_reported():
    rows = [{**ROW, "status": "out_of_stock", "dedupe_key": "a"},
            {**ROW, "dedupe_key": "b", "purchase_price_uah": "abc"},
            {**ROW, "dedupe_key": "c", "category": "weird"}]
    r = plan_import(rows, {}, M)["report"]
    assert r["skipped_unavailable"] == 1 and len(r["errors"]) == 2 and r["to_insert"] == 0


def test_duplicates_in_file_detected():
    r = plan_import([ROW, dict(ROW)], {}, M)["report"]
    assert r["to_insert"] == 1 and "дублікат" in r["errors"][0]["error"]


def test_reimport_idempotent_and_price_update_no_double_markup():
    first = plan_import([ROW], {}, M)
    existing = {d["dedupe_key"]: d for d in first["insert"]}
    assert plan_import([ROW], existing, M)["report"]["unchanged"] == 1
    plan = plan_import([{**ROW, "purchase_price_uah": "300"}], existing, M)
    assert plan["report"]["to_update"] == 1
    assert plan["update"][0][1]["final_price"] == Decimal("310.00")


def test_expected_status_label():
    d = normalize({**ROW, "status": "expected"}, M)
    assert d["status_label"] == "Очікується на прибуття"


def test_real_file_has_no_errors_and_blocks_liquids():
    f = Path(__file__).resolve().parent.parent / "imports" / "products_clean.json"
    rows = json.loads(f.read_text(encoding="utf-8"))
    p = plan_import(rows, {}, M)
    assert p["report"]["errors"] == [] and p["report"]["to_insert"] == len(rows) == 800
    assert all(d["compliance"]["status"] == "blocked_by_law" for d in p["insert"] if d["category"] == "liquid")
    assert all(d["final_price"] is not None for d in p["insert"])
