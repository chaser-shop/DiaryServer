"""Налаштування з .env / змінних середовища. Секрети в коді не зберігаються."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_env() -> None:
    f = ROOT / ".env"
    if not f.exists():
        return
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()


class _Settings:
    @property
    def mongodb_uri(self) -> str:
        return os.environ.get("MONGODB_URI", "")

    @property
    def mongodb_database(self) -> str:
        return os.environ.get("MONGODB_DATABASE", "backoffice")

    @property
    def jwt_secret(self) -> str:
        s = os.environ.get("JWT_SECRET", "")
        if len(s) < 32:
            raise RuntimeError("JWT_SECRET має бути заданий і містити щонайменше 32 символи")
        return s

    @property
    def token_ttl_minutes(self) -> int:
        return int(os.environ.get("TOKEN_TTL_MINUTES", "480"))

    @property
    def images_dir(self) -> Path:
        return Path(os.environ.get("IMAGES_DIR", str(ROOT / "imports" / "images")))


settings = _Settings()
