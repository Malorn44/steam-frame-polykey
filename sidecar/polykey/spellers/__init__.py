"""The spellers, by the composer each spells for, the one list of them: a speller spells text as the keys
a keyboard types it with, one character a key, so what is typed matches a word as typing it goes (하 is
already the start of 한국). The schema's composer ids are checked against it (test_spellers.py).

A suggest request names the keyboard while its mode composes; the speller for that keyboard's composer,
made with the keyboard's table, spells the prefix and the word list. Any other lookup, and a composer
with no speller, spells with LOWERCASE. Text is typed: never logged.
"""

from __future__ import annotations

from typing import Callable, Mapping, Optional, Protocol

from ..packs import COMPOSER_TABLES
from .hangul import HangulSpeller


class Speller(Protocol):
    def spell(self, text: str) -> Optional[str]:
        """The keys text is typed with, or None for text this speller does not spell."""
        ...


class LowercaseSpeller:
    """The default: a word's keys are its letters, whatever their case (ok completes to OK)."""

    def spell(self, text: str) -> Optional[str]:
        return text.lower()


LOWERCASE = LowercaseSpeller()

# Each speller, by composer id, made with the table field that composer reads (COMPOSER_TABLES).
SPELLERS: dict[str, Callable[[dict], Speller]] = {
    "hangul-2set": HangulSpeller,
}


class Spellers:
    """The speller for each keyboard, made on first use from its composer and table in `catalog()` (the
    keyboards and tables the page has); keyboards with the same composer and table share one."""

    def __init__(self, catalog: Callable[[], Mapping[str, Mapping[str, dict]]]) -> None:
        self._catalog = catalog
        self._made: dict[tuple[str, str], tuple[dict, Speller]] = {}

    def get(self, keyboard_id: str) -> Speller:
        catalog = self._catalog()
        keyboard = catalog.get("keyboards", {}).get(keyboard_id, {})
        composer, table_id = keyboard.get("composer"), keyboard.get("table")
        table = catalog.get("tables", {}).get(table_id)
        if composer not in SPELLERS or not isinstance(table, dict) or COMPOSER_TABLES[composer] not in table:
            return LOWERCASE
        made = self._made.get((composer, table_id))
        if made is None or made[0] is not table:  # a table loaded anew is spelled anew
            made = self._made[(composer, table_id)] = (table, SPELLERS[composer](table[COMPOSER_TABLES[composer]]))
        return made[1]
