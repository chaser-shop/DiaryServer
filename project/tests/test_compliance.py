from backend.services.compliance import classify


def test_big_or_strong_liquid_blocked():
    assert classify("liquid", 30, 50)["status"] == "blocked_by_law"
    assert classify("liquid", 10, 50)["status"] == "blocked_by_law"
    assert classify("liquid", None, None)["status"] == "blocked_by_law"


def test_devices_held_for_review():
    assert classify("pod")["status"] == "hold_legal_review"
    assert "tank_over_2ml_check" in classify("cartridge", name="Cartridge 3ml 0.4 ohm")["reasons"]
