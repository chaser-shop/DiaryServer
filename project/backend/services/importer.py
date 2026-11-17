"""Імпорт прайсу (products_clean.json). Чиста логіка: план -> звіт, без запису в БД."""
from decimal import Decimal, InvalidOperation

from .compliance import classify
from .pricing import CATEGORY_LABELS, D, money, reprice, uah_from_usdt

IMPORT_STATUSES = {"in_stock": "В наявності", "expected": "Очікується на прибуття"}
# Поля, які оновлюються з прайсу при повторному імпорті. Решта (редагування адміна) зберігається.
REFRESH_FIELDS = ("purchase_price", "usdt", "status", "status_label", "markup", "final_price")


def _dec(v, field):
    try:
        d = D(v)
        if not d.is_finite() or d < 0:
            raise InvalidOperation
        return d
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError(f"некоректне значення '{field}': {v!r}")


def normalize(raw: dict, markups: dict) -> dict:
    """Один рядок прайсу -> документ товару. Піднімає ValueError при проблемі."""
    status = raw.get("status") or raw.get("availability")
    if status not in IMPORT_STATUSES:
        raise ValueError(f"статус '{status}' не імпортується")
    name, brand = (raw.get("name") or "").strip(), (raw.get("brand") or "").strip()
    if not name or not brand:
        raise ValueError("порожня назва або бренд")
    category = raw.get("category")
    if category is not None and category not in CATEGORY_LABELS:
        raise ValueError(f"невідома категорія '{category}'")
    usdt = None
    if raw.get("purchase_price_usdt") not in (None, ""):
        usdt = {"purchase": _dec(raw["purchase_price_usdt"], "purchase_price_usdt"),
                "rate": _dec(raw.get("usdt_rate"), "usdt_rate")}
        purchase = uah_from_usdt(usdt["purchase"], usdt["rate"])   # вгору до цілої гривні
    else:
        purchase = _dec(raw.get("purchase_price_uah"), "purchase_price_uah")
    key = raw.get("dedupe_key") or f"{brand}|{raw.get('product_line') or ''}|{name.lower()}"
    doc = {
        "name": name, "brand": brand, "category": category,
        "category_label": CATEGORY_LABELS.get(category, "Не визначено"),
        "product_line": raw.get("product_line"), "model": raw.get("model"), "variant": raw.get("variant"),
        "volume_ml": raw.get("volume_ml"), "nicotine_mg": raw.get("nicotine_mg"),
        "pack_size": raw.get("pack_size"), "sku": raw.get("sku"),
        "purchase_price": money(purchase), "usdt": usdt,
        "status": status, "status_label": IMPORT_STATUSES[status],
        "images": raw.get("images") or [], "image_scope": raw.get("image_scope"),
        "dedupe_key": key, "internal": raw.get("internal") or {},
    }
    doc["compliance"] = classify(category, doc["volume_ml"], doc["nicotine_mg"], name)
    doc.update(reprice(doc, markups))
    return doc


def plan_import(rows: list, existing: dict, markups: dict) -> dict:
    """existing: {dedupe_key: документ з БД}. Повертає {'insert','update','report'}."""
    insert, update, errors, seen = [], [], [], set()
    skipped = unchanged = 0
    for i, raw in enumerate(rows):
        try:
            doc = normalize(raw, markups)
        except ValueError as e:
            if "не імпортується" in str(e):
                skipped += 1
            else:
                errors.append({"row": i, "name": raw.get("name"), "error": str(e)})
            continue
        if doc["dedupe_key"] in seen:
            errors.append({"row": i, "name": doc["name"], "error": "дублікат у файлі (dedupe_key)"})
            continue
        seen.add(doc["dedupe_key"])
        old = existing.get(doc["dedupe_key"])
        if old is None:
            insert.append(doc)
            continue
        patch = {k: doc[k] for k in REFRESH_FIELDS}
        if all(old.get(k) == patch[k] for k in REFRESH_FIELDS):
            unchanged += 1
        else:
            update.append((doc["dedupe_key"], patch))
    return {"insert": insert, "update": update, "report": {
        "total_rows": len(rows), "to_insert": len(insert), "to_update": len(update),
        "unchanged": unchanged, "skipped_unavailable": skipped, "errors": errors}}
