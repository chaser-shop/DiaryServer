from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pymongo import UpdateOne

from ..auth.security import audit, current_admin
from ..database import get_db, load, public, to_db
from ..models.schemas import MarkupsIn
from ..services.pricing import DEFAULT_MARKUPS, D, reprice

router = APIRouter(prefix="/api/pricing", tags=["pricing"])


def get_markups(db) -> dict:
    s = db.settings.find_one({"_id": "markups"})
    return {**DEFAULT_MARKUPS, **{k: str(v) for k, v in (s or {}).get("values", {}).items()}}


def _diff(db, new: dict):
    changes = []
    for p in db.products.find({}, {"name": 1, "category": 1, "purchase_price": 1, "final_price": 1, "markup": 1}):
        p = load(p)
        r = reprice(p, new)
        if r["final_price"] != p.get("final_price") or r["markup"] != p.get("markup"):
            changes.append((p, r))
    return changes


@router.get("/markups")
def read(db=Depends(get_db), _=Depends(current_admin)):
    return get_markups(db)


@router.post("/markups/preview")
def preview(body: MarkupsIn, db=Depends(get_db), _=Depends(current_admin)):
    new = {**get_markups(db), **body.markups}
    try:
        ch = _diff(db, new)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"affected": len(ch), "sample": [
        {"name": p["name"], "old": public(p.get("final_price")), "new": public(r["final_price"])} for p, r in ch[:20]]}


@router.put("/markups")
def apply(body: MarkupsIn, db=Depends(get_db), admin=Depends(current_admin)):
    new = {**get_markups(db), **body.markups}
    for v in new.values():
        if D(v) < 0:
            raise HTTPException(422, "Націнка не може бути від'ємною")
    ch = _diff(db, new)
    now = datetime.now(timezone.utc)
    if ch:
        db.products.bulk_write([UpdateOne({"_id": p["_id"]}, {"$set": to_db({**r, "updated_at": now})}) for p, r in ch])
    db.settings.update_one({"_id": "markups"}, {"$set": {"values": new}}, upsert=True)
    audit(db, admin, "pricing.markups", {"markups": new, "repriced": len(ch)})
    return {"markups": new, "repriced": len(ch)}      # старі замовлення не змінюються
