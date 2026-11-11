"""python -m backend.cli create-admin | import-products [--apply] [path]"""
import getpass
import json
import os
import sys
from datetime import datetime, timezone

from .auth.security import hash_password
from .database import ensure_indexes, get_db
from .routes.imports import run_import


def main(argv):
    db = get_db()
    ensure_indexes(db)
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "create-admin":
        user = os.environ.get("ADMIN_USERNAME") or input("Логін: ")
        pw = os.environ.get("ADMIN_PASSWORD") or getpass.getpass("Пароль (мін. 10 символів): ")
        db.admins.update_one({"username": user}, {"$set": {"password_hash": hash_password(pw), "failed": 0,
                             "locked_until": None}, "$setOnInsert": {"created_at": datetime.now(timezone.utc)}}, upsert=True)
        print(f"Адміністратор '{user}' готовий.")
    elif cmd == "import-products":
        apply = "--apply" in argv
        paths = [a for a in argv[2:] if not a.startswith("--")]
        path = paths[0] if paths else "imports/products_clean.json"
        rows = json.load(open(path, encoding="utf-8"))
        rep = run_import(db, rows, dry_run=not apply)
        print(json.dumps(rep, ensure_ascii=False, indent=2))
        if not apply:
            print("Це попередній перегляд. Для запису додайте --apply")
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv)
