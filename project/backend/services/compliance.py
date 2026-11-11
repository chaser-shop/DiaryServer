"""Юридичні позначки (закон № 1978-IX, чинний з 11.07.2023). Не юридична консультація.

blocked_by_law   : не можна продавати за обсягом/міцністю - не замовляється й не публікується.
hold_legal_review: заблоковано до юридичного підтвердження (реклама e-сигарет в інтернеті заборонена).
"""
import re


def classify(category, volume_ml=None, nicotine_mg=None, name: str = "") -> dict:
    if category == "liquid":
        reasons = []
        if volume_ml is None or volume_ml > 10:
            reasons.append("container_over_10ml")
        if nicotine_mg is None or nicotine_mg > 20:
            reasons.append("nicotine_over_20mg_per_ml")
        if reasons:
            return {"status": "blocked_by_law", "reasons": reasons}
        return {"status": "hold_legal_review", "reasons": ["flavor_additives_check", "online_advertising_ban"]}
    reasons = ["online_advertising_ban" if category else "category_unknown"]
    if category == "cartridge":
        m = re.search(r"(\d+(?:\.\d+)?)\s*ml", name or "", re.I)
        if m and float(m.group(1)) > 2:
            reasons.append("tank_over_2ml_check")
    return {"status": "hold_legal_review", "reasons": reasons}
