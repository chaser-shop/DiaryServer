"""Запуск чистих тестів без pytest: python -m tests.run_pure"""
import importlib, sys, traceback
fails = 0
for m in ("test_pricing", "test_importer", "test_compliance"):
    mod = importlib.import_module(f"tests.{m}")
    for n in sorted(x for x in dir(mod) if x.startswith("test_")):
        try:
            getattr(mod, n)(); print("PASS", m, n)
        except Exception:
            fails += 1; print("FAIL", m, n); traceback.print_exc()
sys.exit(1 if fails else 0)
