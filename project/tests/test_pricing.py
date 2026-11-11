from decimal import Decimal

from backend.services.pricing import (DEFAULT_MARKUPS as M, final_price, reprice, uah_from_usdt,
                                      usdt_from_uah)


def test_markups_by_category():
    assert final_price("100", "liquid", M) == Decimal("110.00")
    assert final_price("50", "cartridge", {**M, "cartridge": "5"}) == Decimal("55.00")
    assert final_price("500", "pod", M) == Decimal("570.00")
    assert final_price("104", "cartridge", M) == Decimal("119.00")      # пачка +15
    assert final_price("15", "booster", M) == Decimal("15.00")          # націнка 0


def test_unknown_category_gets_no_markup():
    assert final_price("100", None, M) is None
    assert reprice({"category": None, "purchase_price": Decimal("100")}, M) == {"markup": None, "final_price": None}


def test_markup_not_applied_twice():
    p = {"category": "liquid", "purchase_price": Decimal("240")}
    p.update(reprice(p, M))
    first = p["final_price"]
    for _ in range(3):
        p.update(reprice(p, M))
    assert p["final_price"] == first == Decimal("250.00")


def test_markup_change_recalculates():
    p = {"category": "pod", "purchase_price": Decimal("812")}
    assert reprice(p, {**M, "pod": "100"})["final_price"] == Decimal("912.00")


def test_usdt_rounds_up_to_whole_uah():
    assert uah_from_usdt("11.76", "45.1") == Decimal("531")     # 530.376 -> 531
    assert uah_from_usdt("18", "45.1") == Decimal("812")        # 811.8 -> 812
    assert usdt_from_uah("882", "45.1") == Decimal("19.56")


def test_negative_markup_rejected():
    try:
        final_price("10", "liquid", {**M, "liquid": "-1"})
        assert False
    except ValueError:
        pass
