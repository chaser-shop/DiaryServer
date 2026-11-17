import re
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth.security import audit, current_admin
from ..database import get_db, public
from ..models.schemas import NoteIn, OrderIn, StatusIn
from ..services import orders as svc

router = APIRouter(prefix="/api/orders", tags=["orders"])


@router.get("")
def list_orders(number: str = "", status: str = "", date_from: str = "", date_to: str = "",
                page: int = Query(1, ge=1), db=Depends(get_db), _=Depends(current_admin)):
    f: dict = {}
    if number:
        f["number"] = {"$regex": re.escape(number.strip()), "$options": "i"}
    if status:
        f["status"] = status
    try:
        rng = {}
        if date_from:
            rng["$gte"] = datetime.fromisoformat(date_from)
        if date_to:
            rng["$lt"] = datetime.fromisoformat(date_to) + timedelta(days=1)
    except ValueError:
        raise HTTPException(422, "Дата у форматі YYYY-MM-DD")
    if rng:
        f["created_at"] = rng
    items = list(db.orders.find(f).sort("created_at", -1).skip((page - 1) * 30).limit(30))
    return {"items": [public(i) for i in items], "total": db.orders.count_documents(f),
            "statuses": svc.STATUS_LABELS}


@router.post("", status_code=201)
def create(body: OrderIn, db=Depends(get_db), admin=Depends(current_admin)):
    try:
        o = svc.create_order(db, {"name": body.customer_name, "contact": body.contact},
                             [i.model_dump() for i in body.items], admin)
    except svc.OrderError as e:
        raise HTTPException(422, str(e))
    audit(db, admin, "order.create", {"number": o["number"]})
    return public(o)


@router.patch("/{number}/status")
def status(number: str, body: StatusIn, db=Depends(get_db), admin=Depends(current_admin)):
    try:
        o = svc.set_status(db, number, body.status)
    except svc.OrderError as e:
        raise HTTPException(422, str(e))
    if not o:
        raise HTTPException(404, "Замовлення не знайдено")
    audit(db, admin, "order.status", {"number": number, "status": body.status})
    return public(o)


@router.post("/{number}/notes")
def note(number: str, body: NoteIn, db=Depends(get_db), admin=Depends(current_admin)):
    try:
        o = svc.add_note(db, number, body.text, admin)
    except svc.OrderError as e:
        raise HTTPException(422, str(e))
    if not o:
        raise HTTPException(404, "Замовлення не знайдено")
    return public(o)
