from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pymongo.errors import PyMongoError

from .database import ensure_indexes, get_db
from .routes import auth, imports, orders, pricing, products, settings


@asynccontextmanager
async def lifespan(app):
    ensure_indexes(get_db())
    yield


app = FastAPI(title="Back-office", lifespan=lifespan, docs_url=None, redoc_url=None)
for r in (auth, products, pricing, imports, orders, settings):
    app.include_router(r.router)


@app.exception_handler(PyMongoError)
async def mongo_error(_: Request, exc: PyMongoError):
    return JSONResponse({"detail": "База даних тимчасово недоступна"}, status_code=503)


@app.get("/health")
def health():
    try:
        get_db().command("ping")
        return {"ok": True}
    except Exception:
        return JSONResponse({"ok": False}, status_code=503)


@app.get("/")
def root():
    return RedirectResponse("/admin/")


app.mount("/admin", StaticFiles(directory=Path(__file__).resolve().parent.parent / "frontend" / "admin", html=True))
