"""One bundled layout's own checks: it loads on its own, and its rows are as wide as its kind of layout
needs. tests/layout.test.ts checks the same layout in the page. CI runs both for each layout
(`npm run test:layout -- ja/flick`); POLYKEY_LAYOUT names the layout, and without it every bundled layout
is checked."""
from __future__ import annotations

import functools
import os
import shutil
import tempfile
from pathlib import Path

import pytest

from polykey import packs

REPO = Path(__file__).resolve().parents[2]
SCHEMA = REPO / "schema" / "pack.schema.json"
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


def layout_ids() -> list[str]:
    only = os.environ.get("POLYKEY_LAYOUT")
    return [only] if only else sorted(full_boot()["catalog"]["layouts"])


def width(row: list) -> float:
    return sum(key.get("w", 1) if isinstance(key, dict) else 1 for key in row)


def has_ctrl(rows: list) -> bool:
    return any(isinstance(key, dict) and key.get("type") == "mod" and key.get("mod") == "ctrl" for row in rows for key in row)


each_layout = pytest.mark.parametrize("layout_id", layout_ids())


@each_layout
def test_it_is_one_bundled_layout(layout_id):
    assert layout_id in files_by_id(), f"no bundled pack has the id {layout_id}"
    assert len(files_by_id()[layout_id]) == 1, f"{layout_id} is defined by {', '.join(map(str, files_by_id()[layout_id]))}"
    assert raw(layout_id).get("kind") == "layout"


@each_layout
def test_it_validates_against_the_schema(layout_id):
    schema = packs.read_json(SCHEMA.read_text(encoding="utf-8"))
    assert packs.validate(raw(layout_id), schema, schema) == []


@each_layout
def test_it_loads_on_its_own(layout_id, tmp_path):
    """With only the packs it names (what it extends, its modify table), it loads with no pack errors,
    and comes out as it does from the whole bundle: nothing else changes it."""
    needed: set[str] = set()
    todo = [layout_id]
    while todo:
        item_id = todo.pop()
        if item_id in needed:
            continue
        assert item_id in files_by_id(), f"{layout_id} needs {item_id}, which no bundled pack defines"
        needed.add(item_id)
        data = raw(item_id)
        todo += [ref for ref in (data.get("extends"), data.get("modify")) if isinstance(ref, str)]
    alone = tmp_path / "packs"
    for item_id in needed:
        source = files_by_id()[item_id][0]
        (alone / source.parent.name).mkdir(parents=True, exist_ok=True)
        shutil.copy(source, alone / source.parent.name / source.name)

    boot = packs.load(alone, SCHEMA, tmp_path / "user")
    # On its own there are no keyboards or themes for the settings to name; that is not the layout's.
    assert [e for e in boot["errors"] if not e.startswith("settings.json:")] == []
    assert boot["catalog"]["layouts"].get(layout_id) == full_boot()["catalog"]["layouts"].get(layout_id)


@each_layout
def test_the_whole_bundle_reports_nothing_about_it(layout_id):
    names = tuple(f"{p.parent.name}/{p.name}:" for p in files_by_id().get(layout_id, []))
    assert [e for e in full_boot()["errors"] if e.startswith((f"{layout_id}:", *names))] == []
    assert layout_id in full_boot()["catalog"]["layouts"]


@each_layout
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
    problems = [f"{label} {index} is {width(row):g} units wide, not {units:g} ({reason})"
                for label, each in shown for index, row in enumerate(each)
                for reason, units in needs if abs(width(row) - units) > 1e-6]
    assert problems == []
