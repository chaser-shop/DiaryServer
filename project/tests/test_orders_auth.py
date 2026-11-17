"""Потребують: pip install -r requirements.txt (mongomock, fastapi, httpx, argon2-cffi)."""
import os
from decimal import Decimal

import pytest

pytest.importorskip("mongomock")
pytest.importorskip("argon2")
import mongomock  # noqa: E402

from backend.database import to_db  # noqa: E402
from backend.services import orders as svc  # noqa: E402


@pytest.fixture()
def db():
    d = mongomock.MongoClient().db
    ok = d.products.insert_one(to_db({"name": "Pod A", "brand": "X", "category": "pod", "status": "in_stock",
                                      "final_price": Decimal("882"), "compliance": {"status": "hold_legal_review"}}))
    bad = d.products.insert_one(to_db({"name": "Liq", "brand": "Y", "category": "liquid", "status": "in_stock",
                                       "final_price": Decimal("250"), "compliance": {"status": "blocked_by_law"}}))
    d.ids = (str(ok.inserted_id), str(bad.inserted_id))
    return d


def test_order_uses_server_price_and_snapshots_it(db):
    o = svc.create_order(db, {"name": "A"}, [{"product_id": db.ids[0], "qty": 2}, {"product_id": db.ids[0], "qty": 1}], "adm")
    assert o["total"] == Decimal("2646.00") and len(o["items"]) == 1 and o["items"][0]["qty"] == 3
    db.products.update_one({}, {"$set": {"final_price": to_db(Decimal("1"))}})      # прайс змінився
    stored = db.orders.find_one({"number": o["number"]})
    assert str(stored["items"][0]["unit_price"]) == "882.00"


def test_blocked_product_cannot_be_ordered(db):
    with pytest.raises(svc.OrderError):
        svc.create_order(db, {"name": "A"}, [{"product_id": db.ids[1], "qty": 1}], "adm")


def test_invalid_quantity_and_empty(db):
    with pytest.raises(svc.OrderError):
        svc.create_order(db, {}, [{"product_id": db.ids[0], "qty": 0}], "adm")
    with pytest.raises(svc.OrderError):
        svc.create_order(db, {}, [], "adm")


def test_unique_order_numbers_and_status(db):
    a = svc.create_order(db, {"name": "A"}, [{"product_id": db.ids[0], "qty": 1}], "adm")
    b = svc.create_order(db, {"name": "B"}, [{"product_id": db.ids[0], "qty": 1}], "adm")
    assert a["number"] != b["number"]
    assert svc.set_status(db, a["number"], "confirmed")["status"] == "confirmed"
    with pytest.raises(svc.OrderError):
        svc.set_status(db, a["number"], "nonsense")


def test_admin_routes_require_auth(monkeypatch):
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient
    monkeypatch.setenv("JWT_SECRET", "x" * 40)
    from backend.database import get_db
    from backend.main import app
    app.dependency_overrides[get_db] = lambda: mongomock.MongoClient().db
    c = TestClient(app)
    for path in ("/api/products", "/api/orders", "/api/pricing/markups", "/api/settings", "/api/brands"):
        assert c.get(path).status_code == 401
    assert c.get("/api/products", headers={"Authorization": "Bearer garbage"}).status_code == 401
