"""The spellers, by the table format each reads, the one list of them: a speller spells text as the keys a
keyboard types it with, one character a key, so what is typed matches a word as typing it goes (하 is
already the start of 한국). pack.schema.json's table formats are checked against it (test_spellers.py).

A suggest request names the keyboard's table when its mode composes; the speller for that table's format
spells the prefix and the word list with it. Text is typed: never logged.
"""

from __future__ import annotations

from typing import Callable, Mapping, Optional, Protocol

from .hangul import HangulSpeller


class Speller(Protocol):
    def spell(self, text: str) -> Optional[str]:
        """The keys text is typed with, or None for text this speller does not spell."""
        ...


# Each speller, by the table field it reads.
SPELLERS: dict[str, Callable[[dict], Speller]] = {
    "hangul": HangulSpeller,
}


class Spellers:
    """A speller for each table that has one, made on first use from `tables()` (the tables the page has)."""

    def __init__(self, tables: Callable[[], Mapping[str, dict]]) -> None:
        self._tables = tables
        self._made: dict[str, tuple[dict, Optional[Speller]]] = {}

    def get(self, table_id: str) -> Optional[Speller]:
        table = self._tables().get(table_id)
        if not isinstance(table, dict):
            return None
        made = self._made.get(table_id)
        if made is None or made[0] is not table:  # a table loaded anew is spelled anew
            speller = next((make(table[field]) for field, make in SPELLERS.items() if field in table), None)
            made = self._made[table_id] = (table, speller)
        return made[1]
