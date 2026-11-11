from typing import Literal

from pydantic import BaseModel, Field

Category = Literal["liquid", "pod", "cartridge", "booster"]


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class ProductIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    brand: str = Field(min_length=1, max_length=80)
    category: Category | None = None
    product_line: str | None = None
    model: str | None = None
    variant: str | None = None
    volume_ml: float | None = Field(None, ge=0)
    nicotine_mg: float | None = Field(None, ge=0)
    purchase_price: str = Field(pattern=r"^\d{1,7}(\.\d{1,2})?$")
    status: Literal["in_stock", "expected", "unavailable"] = "in_stock"
    images: list[str] = []


class ProductPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    category: Category | None = None
    purchase_price: str | None = Field(None, pattern=r"^\d{1,7}(\.\d{1,2})?$")
    status: Literal["in_stock", "expected", "unavailable"] | None = None
    images: list[str] | None = None


class MarkupsIn(BaseModel):
    markups: dict[Category, str]


class OrderItemIn(BaseModel):
    product_id: str
    qty: int = Field(ge=1, le=1000)


class OrderIn(BaseModel):
    customer_name: str = Field(min_length=1, max_length=120)
    contact: str = Field(default="", max_length=120)
    items: list[OrderItemIn] = Field(min_length=1)


class StatusIn(BaseModel):
    status: str


class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
