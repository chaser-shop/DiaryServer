"""Хешування паролів (Argon2), JWT, захист від підбору, журнал дій."""
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, HTTPException, Request

from ..config import settings
from ..database import get_db

_ph = PasswordHasher()
MAX_FAILS, LOCK_MINUTES = 5, 15


def hash_password(p: str) -> str:
    if len(p) < 10:
        raise ValueError("Пароль має містити щонайменше 10 символів")
    return _ph.hash(p)


def authenticate(db, username: str, password: str) -> str:
    """Повертає JWT або піднімає HTTPException. Після 5 невдач - блокування на 15 хв."""
    now = datetime.now(timezone.utc)
    adm = db.admins.find_one({"username": username})
    if adm and adm.get("locked_until") and adm["locked_until"].replace(tzinfo=timezone.utc) > now:
        raise HTTPException(429, "Забагато спроб. Спробуйте пізніше.")
    ok = False
    if adm:
        try:
            ok = _ph.verify(adm["password_hash"], password)
        except VerifyMismatchError:
            ok = False
    if not ok:
        if adm:
            fails = adm.get("failed", 0) + 1
            upd = {"failed": fails}
            if fails >= MAX_FAILS:
                upd = {"failed": 0, "locked_until": now + timedelta(minutes=LOCK_MINUTES)}
            db.admins.update_one({"_id": adm["_id"]}, {"$set": upd})
        raise HTTPException(401, "Невірний логін або пароль")
    db.admins.update_one({"_id": adm["_id"]}, {"$set": {"failed": 0, "locked_until": None}})
    payload = {"sub": username, "exp": now + timedelta(minutes=settings.token_ttl_minutes)}
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def current_admin(request: Request, db=Depends(get_db)) -> str:
    h = request.headers.get("Authorization", "")
    if not h.startswith("Bearer "):
        raise HTTPException(401, "Потрібна авторизація")
    try:
        sub = jwt.decode(h[7:], settings.jwt_secret, algorithms=["HS256"])["sub"]
    except jwt.PyJWTError:
        raise HTTPException(401, "Недійсний або прострочений токен")
    if not db.admins.find_one({"username": sub}):
        raise HTTPException(401, "Адміністратора не знайдено")
    return sub


def audit(db, admin: str, action: str, details: dict | None = None) -> None:
    db.audit_log.insert_one({"admin": admin, "action": action, "details": details or {},
                             "at": datetime.now(timezone.utc)})
