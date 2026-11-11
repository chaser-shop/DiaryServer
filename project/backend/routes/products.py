import re
from datetime import datetime, timezone
from decimal import Decimal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse

from ..auth.security import audit, current_admin
from ..config import settings
from ..database import get_db, load, public, to_db
from ..models.schemas import ProductIn, ProductPatch
from ..services.compliance import classify
from ..services.pricing import CATEGORY_LABELS, D, money, reprice, usdt_from_uah
from .pricing import get_markups

router = APIRouter(prefix="/api", tags=["products"])


def _oid(pid: str) -> ObjectId:
    try:
        return ObjectId(pid)
    except Exception:
        raise HTTPException(404, "Товар не знайдено")


def _with_usdt(p: dict) -> dict:
    """Для сторінки товару: гривня + USDT (якщо в прайсі є курс)."""
    p = load(p)
    u = p.get("usdt")
    if u and p.get("final_price") is not None:
        p["final_price_usdt"] = usdt_from_uah(p["final_price"], u["rate"])
    return p


@router.get("/products")
def list_products(q: str = "", category: str = "", brand: str = "", status: str = "",
                  compliance: str = "", sort: str = "name", page: int = Query(1, ge=1),
                  limit: int = Query(30, ge=1, le=100), db=Depends(get_db), _=Depends(current_admin)):
    f: dict = {}
    if q.strip():
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        f["$or"] = [{"name": rx}, {"brand": rx}, {"model": rx}, {"variant": rx}, {"sku": rx}]
    for k, v in (("category", category), ("brand", brand), ("status", status), ("compliance.status", compliance)):
        if v:
            f[k] = v
    order = {"name": [("name", 1)], "price_asc": [("final_price", 1)], "price_desc": [("final_price", -1)]}.get(sort, [("name", 1)])
    total = db.products.count_documents(f)
    items = list(db.products.find(f).sort(order).skip((page - 1) * limit).limit(limit))
    return {"items": [public(i) for i in items], "total": total, "page": page, "pages": max(1, -(-total // limit))}


@router.get("/brands")
def brands(db=Depends(get_db), _=Depends(current_admin)):
    return sorted(db.products.distinct("brand"))


@router.get("/categories")
def categories(_=Depends(current_admin)):
    return [{"id": k, "label": v} for k, v in CATEGORY_LABELS.items()]


@router.get("/products/{pid}")
def get_product(pid: str, db=Depends(get_db), _=Depends(current_admin)):
    p = db.products.find_one({"_id": _oid(pid)})
    if not p:
        raise HTTPException(404, "Товар не знайдено")
    return public(_with_usdt(p))


@router.post("/products", status_code=201)
def create_product(body: ProductIn, db=Depends(get_db), admin=Depends(current_admin)):
    d = body.model_dump()
    d["purchase_price"] = money(D(d["purchase_price"]))
    d["category_label"] = CATEGORY_LABELS.get(d["category"], "Не визначено")
    d["status_label"] = {"in_stock": "В наявності", "expected": "Очікується на прибуття", "unavailable": "Немає в наявності"}[d["status"]]
    d["dedupe_key"] = f"{d['brand']}|{d.get('product_line') or ''}|{d['name'].lower()}"
    d["compliance"] = classify(d["category"], d.get("volume_ml"), d.get("nicotine_mg"), d["name"])
    d["usdt"], d["internal"], d["image_scope"] = None, {"manual": True}, None
    d.update(reprice(d, get_markups(db)))
    now = datetime.now(timezone.utc)
    d["created_at"] = d["updated_at"] = now
    if db.products.find_one({"dedupe_key": d["dedupe_key"]}):
        raise HTTPException(409, "Такий товар уже існує")
    res = db.products.insert_one(to_db(d))
    audit(db, admin, "product.create", {"id": str(res.inserted_id), "name": d["name"]})
    return public(db.products.find_one({"_id": res.inserted_id}))


@router.patch("/products/{pid}")
def update_product(pid: str, body: ProductPatch, db=Depends(get_db), admin=Depends(current_admin)):
    p = db.products.find_one({"_id": _oid(pid)})
    if not p:
        raise HTTPException(404, "Товар не знайдено")
    p = load(p)
    patch = body.model_dump(exclude_unset=True)
    if "purchase_price" in patch:
        patch["purchase_price"] = money(D(patch["purchase_price"]))
        patch["usdt"] = None          # ручна ціна: USDT-джерело більше неактуальне
    if "category" in patch:
        patch["category_label"] = CATEGORY_LABELS.get(patch["category"], "Не визначено")
    if "status" in patch:
        patch["status_label"] = {"in_stock": "В наявності", "expected": "Очікується на прибуття", "unavailable": "Немає в наявності"}[patch["status"]]
    merged = {**p, **patch}
    if "category" in patch:
        merged["compliance"] = patch["compliance"] = classify(merged["category"], merged.get("volume_ml"), merged.get("nicotine_mg"), merged["name"])
    patch.update(reprice(merged, get_markups(db)))     # завжди від закупівельної, не від final
    patch["updated_at"] = datetime.now(timezone.utc)
    db.products.update_one({"_id": p["_id"]}, {"$set": to_db(patch)})
    audit(db, admin, "product.update", {"id": pid, "fields": [k for k in patch if k != "updated_at"]})
    return public(db.products.find_one({"_id": p["_id"]}))


@router.delete("/products/{pid}")
def delete_product(pid: str, confirm: bool = False, db=Depends(get_db), admin=Depends(current_admin)):
    if not confirm:
        raise HTTPException(400, "Потрібне підтвердження (confirm=true)")
    r = db.products.delete_one({"_id": _oid(pid)})
    if not r.deleted_count:
        raise HTTPException(404, "Товар не знайдено")
    audit(db, admin, "product.delete", {"id": pid})
    return {"deleted": True}


@router.get("/media/{name}")
def media(name: str, _=Depends(current_admin)):
    f = (settings.images_dir / name).resolve()
    if f.parent != settings.images_dir.resolve() or not f.is_file():
        raise HTTPException(404)
    return FileResponse(f)
