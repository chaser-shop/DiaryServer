"""Облік замовлень. Ціни беруться з БД у момент створення й фіксуються в замовленні."""
from datetime import datetime, timezone
from decimal import Decimal

from ..database import load, to_db
from .pricing import money

STATUSES = ["new", "confirmed", "in_progress", "done", "cancelled"]
STATUS_LABELS = {"new": "Нове", "confirmed": "Підтверджене", "in_progress": "У процесі",
                 "done": "Виконане", "cancelled": "Скасоване"}


class OrderError(ValueError):
    pass


def next_number(db) -> str:
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    c = db.counters.find_one_and_update({"_id": f"order-{today}"}, {"$inc": {"seq": 1}},
                                        upsert=True, return_document=True)
    return f"ORD-{today}-{c['seq']:04d}"


def create_order(db, customer: dict, items: list, admin: str) -> dict:
    if not items:
        raise OrderError("Замовлення порожнє")
    merged: dict = {}
    for it in items:                       # однакові товари зливаємо в одну позицію
        qty = int(it["qty"])
        if qty < 1 or qty > 1000:
            raise OrderError("Кількість має бути від 1 до 1000")
        merged[it["product_id"]] = merged.get(it["product_id"], 0) + qty
    from bson import ObjectId
    lines, total = [], Decimal("0")
    for pid, qty in merged.items():
        try:
            p = db.products.find_one({"_id": ObjectId(pid)})
        except Exception:
            p = None
        if not p:
            raise OrderError(f"Товар {pid} не знайдено")
        p = load(p)
        if p.get("compliance", {}).get("status") == "blocked_by_law":
            raise OrderError(f"«{p['name']}» заборонений до продажу законом і не може бути в замовленні")
        if p.get("status") != "in_stock":
            raise OrderError(f"«{p['name']}» зараз не в наявності")
        if p.get("final_price") is None:
            raise OrderError(f"«{p['name']}» не має кінцевої ціни (невідома категорія)")
        price = money(p["final_price"])            # ціна ВІД СЕРВЕРА, не від клієнта
        total += price * qty
        lines.append({"product_id": pid, "name": p["name"], "brand": p["brand"],
                      "qty": qty, "unit_price": price, "line_total": money(price * qty)})
    doc = {"number": next_number(db), "customer": customer, "items": lines, "total": money(total),
           "currency": "UAH", "status": "new", "notes": [], "created_by": admin,
           "created_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc)}
    res = db.orders.insert_one(to_db(doc))
    doc["_id"] = res.inserted_id
    return doc


def set_status(db, number: str, status: str):
    if status not in STATUSES:
        raise OrderError("Невідомий статус")
    return db.orders.find_one_and_update(
        {"number": number}, {"$set": {"status": status, "updated_at": datetime.now(timezone.utc)}},
        return_document=True)


def add_note(db, number: str, text: str, admin: str):
    note = {"text": text.strip(), "by": admin, "at": datetime.now(timezone.utc)}
    if not note["text"]:
        raise OrderError("Порожня примітка")
    return db.orders.find_one_and_update({"number": number}, {"$push": {"notes": note}}, return_document=True)
