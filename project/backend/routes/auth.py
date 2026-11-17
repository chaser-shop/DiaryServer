from fastapi import APIRouter, Depends

from ..auth.security import audit, authenticate, current_admin
from ..database import get_db
from ..models.schemas import LoginIn

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
def login(body: LoginIn, db=Depends(get_db)):
    token = authenticate(db, body.username, body.password)
    audit(db, body.username, "login")
    return {"token": token}


@router.get("/me")
def me(admin: str = Depends(current_admin)):
    return {"username": admin}
