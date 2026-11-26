"""Each bundled pack's own checks (its layouts, keyboards, tables, languages and themes): it is defined
once, is valid, and loads on its own as it does in the whole bundle; a layout's rows are as wide as its kind
of layout needs, and a keyboard's swipe option is off until turned on. tests/layout.test.ts checks each layout
in the page."""

from __future__ import annotations

import functools
import shutil
import tempfile
from pathlib import Path

import pytest

from polykey import packs

REPO = Path(__file__).resolve().parents[2]
SCHEMA = REPO / "packs" / "pack.schema.json"
BUNDLED = REPO / "packs"
# A full keyboard (one with Ctrl) is as wide as en/qwerty, in key units.
FULL_KEYBOARD_UNITS = 15


@functools.cache
def full_boot() -> dict:
    """The boot data from every bundled pack, as the page gets it (no user packs or settings)."""
    with tempfile.TemporaryDirectory() as empty:
        return packs.load(BUNDLED, SCHEMA, Path(empty))


@functools.cache
def files_by_id() -> dict[str, list[Path]]:
    """The bundled files that define each id."""
    found: dict[str, list[Path]] = {}
    for path in sorted(BUNDLED.glob("*/*.json")):
        try:
            data = packs.read_json(path.read_text(encoding="utf-8"))
        except ValueError:
            continue  # the loader reports it (test_packs.py)
        if isinstance(data, dict) and isinstance(data.get("id"), str):
            found.setdefault(data["id"], []).append(path)
    return found


def raw(item_id: str) -> dict:
    return packs.read_json(files_by_id()[item_id][0].read_text(encoding="utf-8"))


def pack_ids(*kinds: str) -> list[str]:
    return sorted(item_id for item_id in files_by_id() if raw(item_id).get("kind") in kinds)


def named(value: object) -> list[str]:
    """The bundled packs named anywhere in a pack: what it extends, its layouts and pages, its tables."""
    if isinstance(value, dict):
        return [item_id for v in value.values() for item_id in named(v)]
    if isinstance(value, list):
        return [item_id for v in value for item_id in named(v)]
    return [value] if isinstance(value, str) and value in files_by_id() else []


def width(row: list) -> float:
    return sum(key.get("w", 1) if isinstance(key, dict) else 1 for key in row)


def has_ctrl(rows: list) -> bool:
    return any(
        isinstance(key, dict) and key.get("type") == "mod" and key.get("mod") == "ctrl" for row in rows for key in row
    )


each_pack = pytest.mark.parametrize("pack_id", pack_ids(*packs.KINDS))


@each_pack
def test_it_is_one_bundled_pack(pack_id):
    assert len(files_by_id()[pack_id]) == 1, f"{pack_id} is defined by {', '.join(map(str, files_by_id()[pack_id]))}"


@each_pack
def test_it_validates_against_the_schema(pack_id):
    schema = packs.read_json(SCHEMA.read_text(encoding="utf-8"))
    assert packs.validate(raw(pack_id), schema, schema) == []


@each_pack
def test_it_loads_on_its_own(pack_id, tmp_path):
    """With only the packs it names, it loads with no pack errors, and comes out as it does from the whole
    bundle: nothing else changes it."""
    needed: set[str] = set()
    todo = [pack_id]
    while todo:
        item_id = todo.pop()
        if item_id not in needed:
            needed.add(item_id)
            todo += named(raw(item_id))
    alone = tmp_path / "packs"
    for item_id in needed:
        source = files_by_id()[item_id][0]
        (alone / source.parent.name).mkdir(parents=True, exist_ok=True)
        shutil.copy(source, alone / source.parent.name / source.name)

    boot = packs.load(alone, SCHEMA, tmp_path / "user")
    # On its own there may be no keyboard or theme the settings name; that is not the pack's.
    assert [e for e in boot["errors"] if not e.startswith("settings.json:")] == []
    kind = packs.KINDS[raw(pack_id)["kind"]]
    assert boot["catalog"][kind].get(pack_id) == full_boot()["catalog"][kind].get(pack_id)


@each_pack
def test_the_whole_bundle_reports_nothing_about_it(pack_id):
    names = tuple(f"{p.parent.name}/{p.name}:" for p in files_by_id().get(pack_id, []))
    assert [e for e in full_boot()["errors"] if e.startswith((f"{pack_id}:", *names))] == []
    assert pack_id in full_boot()["catalog"][packs.KINDS[raw(pack_id)["kind"]]]


@pytest.mark.parametrize("layout_id", pack_ids("layout"))
def test_its_rows_are_as_wide_as_its_kind_needs(layout_id):
    """Every row as wide as the first, with 🌐 hidden too (one keyboard in the list); a full keyboard
    (with Ctrl) 15 units, as en/qwerty; a layout that extends another as wide as that one."""
    layouts = full_boot()["catalog"]["layouts"]
    layout = layouts[layout_id]
    rows = layout["rows"]
    needs = [("as wide as row 0", width(rows[0]))]
    if has_ctrl(rows):
        needs.append(("a full keyboard, with Ctrl", FULL_KEYBOARD_UNITS))
    base = raw(layout_id).get("extends")
    if base in layouts:
        needs.append((f"as wide as {base}, which it extends", width(layouts[base]["rows"][0])))
    shown = [("row", rows), ("with one keyboard, row", layout.get("aloneRows", []))]
    problems = [
        f"{label} {index} is {width(row):g} units wide, not {units:g} ({reason})"
        for label, each in shown
        for index, row in enumerate(each)
        for reason, units in needs
        if abs(width(row) - units) > 1e-6
    ]
    assert problems == []


@pytest.mark.parametrize("keyboard_id", pack_ids("keyboard"))
def test_swipe_is_off_until_turned_on(keyboard_id):
    assert full_boot()["catalog"]["keyboards"][keyboard_id].get("options", {}).get("swipe", False) is False
