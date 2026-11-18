"""What the pack tests share: the bundled packs as the loader resolves them, a layout's keys, and the packs a
test writes of its own."""

from __future__ import annotations

import functools
import json
import tempfile
from pathlib import Path

from polykey import packs

REPO = Path(__file__).resolve().parents[2]
BUNDLED = REPO / "packs"
SCHEMA = BUNDLED / "pack.schema.json"


@functools.cache
def bundled_boot() -> dict:
    """The boot data from every bundled pack, as the page gets it (no user packs or settings). Shared: read it,
    never change it."""
    with tempfile.TemporaryDirectory() as empty:
        return packs.load(BUNDLED, SCHEMA, Path(empty))


def load(user: Path) -> dict:
    """The bundled packs and a user's (`user` holds their packs folder and settings), as the sidecar loads them."""
    return packs.load(BUNDLED, SCHEMA, user)


def as_key(key: str | dict) -> dict:
    """A key in a layout's rows, where a string is a char key."""
    return {"type": "char", "char": key} if isinstance(key, str) else key


def typed_by(key: str | dict) -> set[str]:
    """Everything a key types: its char and Shift's, its flicks, its tap cycle and what holding it offers."""
    key = as_key(key)
    return {key.get("char", ""), key.get("shift", "")} | {
        *key.get("flick", {}).values(),
        *key.get("cycle", []),
        *key.get("long", []),
    }


def write(directory: Path, name: str, data) -> None:
    path = directory / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")


def theme(item_id: str, surface: str = "#000000") -> dict:
    return {
        "schemaVersion": 1,
        "kind": "theme",
        "id": item_id,
        "name": "T",
        "colors": {
            "surface": surface,
            "key": "#111111",
            "keyText": "#ffffff",
            "modifier": "#222222",
            "accent": "#ff0000",
        },
    }


def layout(item_id: str, **fields) -> dict:
    return {
        "schemaVersion": 1,
        "kind": "layout",
        "id": item_id,
        "name": item_id,
        "rows": [[{"type": "char", "char": "a"}]],
        **fields,
    }


def keyboard(item_id: str, **fields) -> dict:
    return {"schemaVersion": 1, "kind": "keyboard", "id": item_id, "name": item_id, **fields}


def language(code: str, **fields) -> dict:
    return {"schemaVersion": 1, "kind": "language", "id": code, "name": code, **fields}
