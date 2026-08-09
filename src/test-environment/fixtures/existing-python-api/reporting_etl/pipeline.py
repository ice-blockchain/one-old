"""The reporting pipeline this project already had."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Row:
    """One settled order, as the warehouse stores it."""

    order_id: str
    total_cents: int


def total_cents(rows: list[Row]) -> int:
    """Sum a batch of rows."""
    return sum(row.total_cents for row in rows)
