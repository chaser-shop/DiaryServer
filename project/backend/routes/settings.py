from fastapi import APIRouter, Depends

from ..auth.security import audit, current_admin
from ..database import get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])
ALLOWED = {"shop_name", "contact"}


@router.get("")
def read(db=Depends(get_db), _=Depends(current_admin)):
    s = db.settings.find_one({"_id": "general"}) or {}
    return {k: s.get(k, "") for k in ALLOWED}


@router.put("")
def write(body: dict, db=Depends(get_db), admin=Depends(current_admin)):
    data = {k: str(v)[:200] for k, v in body.items() if k in ALLOWED}
    db.settings.update_one({"_id": "general"}, {"$set": data}, upsert=True)
    audit(db, admin, "settings.update", data)
    return data
