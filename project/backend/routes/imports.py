import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pymongo import UpdateOne

from ..auth.security import audit, current_admin
from ..database import get_db, load, to_db
from ..services.importer import plan_import
from .pricing import get_markups

router = APIRouter(prefix="/api/import", tags=["import"])


def run_import(db, rows: list, dry_run: bool) -> dict:
    keys = [r.get("dedupe_key") for r in rows if r.get("dedupe_key")]
    existing = {p["dedupe_key"]: load(p) for p in db.products.find({"dedupe_key": {"$in": keys}})}
    plan = plan_import(rows, existing, get_markups(db))
    report = {**plan["report"], "dry_run": dry_run}
    if not dry_run:
        now = datetime.now(timezone.utc)
        if plan["insert"]:
            db.products.insert_many([to_db({**d, "created_at": now, "updated_at": now}) for d in plan["insert"]])
        if plan["update"]:
            db.products.bulk_write([UpdateOne({"dedupe_key": k}, {"$set": to_db({**patch, "updated_at": now})})
                                    for k, patch in plan["update"]])
    return report


@router.post("")
async def import_file(dry_run: bool = True, file: UploadFile = File(...), db=Depends(get_db), admin=Depends(current_admin)):
    if not (file.filename or "").lower().endswith(".json"):
        raise HTTPException(415, "Підтримується products_clean.json (CSV/Excel - див. README)")
    raw = await file.read()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(413, "Файл завеликий")
    try:
        rows = json.loads(raw)
        assert isinstance(rows, list)
    except Exception:
        raise HTTPException(422, "Некоректний JSON: очікується список товарів")
    report = run_import(db, rows, dry_run)
    if not dry_run:
        audit(db, admin, "import.apply", {k: v for k, v in report.items() if k != "errors"})
    return report
