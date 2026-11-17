"""Централізоване ціноутворення. Чиста логіка, без залежностей від БД.

Кінцева ціна = закупівельна + націнка категорії. Функція завжди рахує від
закупівельної ціни, тому націнка не може додатися двічі.
"""
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal

DEFAULT_MARKUPS = {"liquid": "10", "pod": "70", "cartridge": "15", "booster": "0"}
CATEGORY_LABELS = {"liquid": "Рідини", "pod": "Под-системи", "cartridge": "Картриджі (пачки)", "booster": "Підсилювачі"}


def D(v) -> Decimal:
    return v if isinstance(v, Decimal) else Decimal(str(v))


def money(v) -> Decimal:
    return D(v).quantize(Decimal("0.01"), ROUND_HALF_UP)


def uah_from_usdt(usdt, rate) -> Decimal:
    """USDT * курс, округлення ВГОРУ до цілої гривні."""
    return (D(usdt) * D(rate)).to_integral_value(ROUND_CEILING)


def usdt_from_uah(uah, rate) -> Decimal:
    """Ціна в USDT для картки товару, округлення вгору до 0.01."""
    return (D(uah) / D(rate)).quantize(Decimal("0.01"), ROUND_CEILING)


def markup_for(category, markups: dict):
    """None, якщо категорія невідома: націнка навмання не застосовується."""
    if category is None or category not in markups:
        return None
    m = D(markups[category])
    if m < 0:
        raise ValueError("Націнка не може бути від'ємною")
    return m


def final_price(purchase, category, markups: dict):
    m = markup_for(category, markups)
    if m is None or purchase is None:
        return None
    return money(D(purchase) + m)


def reprice(product: dict, markups: dict) -> dict:
    """Повертає поля markup/final_price (purchase_price не чіпає)."""
    m = markup_for(product.get("category"), markups)
    return {
        "markup": None if m is None else money(m),
        "final_price": final_price(product.get("purchase_price"), product.get("category"), markups),
    }
