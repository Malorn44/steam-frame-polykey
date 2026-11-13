"""The converters a keyboard's "converter" names, the one list of them: pack.schema.json's converter enum
is checked against it (test_converters.py). The bridge's convert, predict and learn go to the one a
request names; each is loaded on its first request. Requests carry typed text: never logged.
"""

from __future__ import annotations

from typing import Optional

from .anthy import Anthy
from .engine import Converter

# Each converter's engine, by the id packs use.
CONVERTERS = {
    "anthy": Anthy,
}


class Converters:
    """The registry's converters (or the ones given, for tests), by id."""

    def __init__(self, converters: Optional[dict[str, Converter]] = None) -> None:
        self._converters = (
            converters if converters is not None else {name: Converter(engine) for name, engine in CONVERTERS.items()}
        )

    def handle(self, op: str, request: dict) -> dict:
        name = request.get("converter")
        converter = self._converters.get(name) if isinstance(name, str) else None
        if converter is None:
            return {"ok": False, "error": "unknown-converter"}
        return converter.handle(op, request)
