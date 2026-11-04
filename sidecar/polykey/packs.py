"""Load and validate packs (layouts, keyboards, themes) and the user's settings.

Bundled packs come first; a user pack in ~/.config/polykey/packs/ replaces the bundled item with the
same id. Files are validated against schema/pack.schema.json with a small stdlib validator for the
subset of JSON Schema that file uses. Bad files are skipped and reported, never fatal.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Optional

MAX_FILE_BYTES = 256 * 1024
MAX_FILES_PER_DIR = 256
KINDS = {"layout": "layouts", "keyboard": "keyboards", "theme": "themes", "table": "tables"}
DEFAULT_SETTINGS = {"keyboards": ["en/english", "ja/12key", "ja/50on", "ja/romaji", "ja/jis"], "theme": "themes/steam", "haptics": True, "suggestions": True}
# Per-keyboard options the page may set (settings.json "keyboardOptions": {keyboard id: {option: bool}}).
KEYBOARD_OPTIONS = ("tapCycle", "candidatesLeft", "flickHints", "romajiInput", "qwertyLatin", "swipe")


# The strip above the keys, for a layout that does not set its own ("toolbar": [] means none).
DEFAULT_TOOLBAR = [{"type": "action", "action": a}
                   for a in ("settings", "emoji", "dictate", "copy", "cut", "paste", "menu", "hide")]


MAX_KEYBOARDS = 20
KEYBOARD_ID = re.compile(r"^[a-z0-9-]+/[a-z0-9-]+$")


def clean_keyboard_list(value: object) -> bool:
    """Whether a keyboards list from the page is sane: 1-20 distinct ids."""
    return (isinstance(value, list) and 0 < len(value) <= MAX_KEYBOARDS and len(set(value)) == len(value)
            and all(isinstance(k, str) and KEYBOARD_ID.match(k) for k in value))


def clean_keyboard_options(value: object) -> Optional[dict]:
    """{keyboard id: {known option: bool}}, or None when it is not that shape."""
    if not isinstance(value, dict) or len(value) > 64:
        return None
    clean = {}
    for keyboard, options in value.items():
        if not isinstance(keyboard, str) or not 0 < len(keyboard) <= 80 or not isinstance(options, dict):
            return None
        if any(k not in KEYBOARD_OPTIONS or not isinstance(v, bool) for k, v in options.items()):
            return None
        clean[keyboard] = dict(options)
    return clean


def user_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "polykey"


# --- validator -----------------------------------------------------------------------------------

_TYPES = {"object": dict, "array": list, "string": str, "boolean": bool}


def validate(value: Any, schema: dict, root: dict, path: str = "") -> list[str]:
    """Errors as "path: reason" (empty when valid)."""
    if "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[-1]
        return validate(value, root["$defs"][name], root, path)
    if "oneOf" in schema:
        results = [validate(value, option, root, path) for option in schema["oneOf"]]
        valid = sum(1 for r in results if not r)
        if valid == 1:
            return []
        if valid > 1:
            return [f"{path or '/'}: matches more than one option"]
        # Report the option the value was meant to be: its "type"/"kind" matched.
        tags = (f"{path}/type: must be", f"{path}/kind: must be")
        wrong_type = (f"{path or '/'}: must be a ", f"{path or '/'}: must be an ")
        meant = [r for r in results
                 if not any(e.startswith(tags) for e in r) and not (len(r) == 1 and r[0].startswith(wrong_type))]
        return min(meant, key=len) if meant else max(results, key=lambda r: max(e.count("/") for e in r))
    errors: list[str] = []
    where = path or "/"
    if "const" in schema and value != schema["const"]:
        return [f"{where}: must be {json.dumps(schema['const'])}"]
    if "enum" in schema and value not in schema["enum"]:
        return [f"{where}: must be one of {', '.join(map(str, schema['enum']))}"]
    kind = schema.get("type")
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return [f"{where}: must be a number"]
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{where}: must be at least {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{where}: must be at most {schema['maximum']}")
    elif kind in _TYPES and not isinstance(value, _TYPES[kind]):
        return [f"{where}: must be a{'n' if kind[0] in 'aeiou' else ''} {kind}"]
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{where}: too short")
        if len(value) > schema.get("maxLength", 1 << 30):
            errors.append(f"{where}: too long")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{where}: does not match {schema['pattern']}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{where}: needs at least {schema['minItems']} items")
        if len(value) > schema.get("maxItems", 1 << 30):
            errors.append(f"{where}: at most {schema['maxItems']} items")
        if "items" in schema:
            for i, item in enumerate(value):
                errors += validate(item, schema["items"], root, f"{path}/{i}")
    if isinstance(value, dict):
        for name in schema.get("required", []):
            if name not in value:
                errors.append(f"{where}: missing {name}")
        properties = schema.get("properties", {})
        patterns = schema.get("patternProperties", {})
        for name, item in value.items():
            if name in properties:
                errors += validate(item, properties[name], root, f"{path}/{name}")
            elif any(re.search(p, name) for p in patterns):
                pattern = next(p for p in patterns if re.search(p, name))
                errors += validate(item, patterns[pattern], root, f"{path}/{name}")
            elif schema.get("additionalProperties") is False:
                errors.append(f"{where}: unknown field {name}")
    return errors


# --- loading -------------------------------------------------------------------------------------


def _scan(directory: Path, schema: dict, errors: list[str]) -> dict[str, dict]:
    """Valid items under directory/<namespace>/*.json, by id."""
    items: dict[str, dict] = {}
    if not directory.is_dir():
        return items
    files = sorted(directory.glob("*/*.json"))[:MAX_FILES_PER_DIR]
    for file in files:
        name = f"{file.parent.name}/{file.name}"
        try:
            if file.stat().st_size > MAX_FILE_BYTES:
                errors.append(f"{name}: larger than {MAX_FILE_BYTES // 1024} KiB")
                continue
            data = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            errors.append(f"{name}: not valid JSON ({type(error).__name__})")
            continue
        problems = validate(data, schema, schema)
        if not problems and data["id"].split("/")[0] != file.parent.name:
            problems = [f"/id: must start with {file.parent.name}/ (the folder name)"]
        if not problems and data["id"] in items:
            problems = [f"/id: {data['id']} is defined twice"]
        if problems:
            errors.append(f"{name}: {problems[0]}" + (f" (+{len(problems) - 1} more)" if len(problems) > 1 else ""))
            continue
        data.pop("$schema", None)
        items[data["id"]] = data
    return items


def load_settings(path: Path, errors: list[str]) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return dict(DEFAULT_SETTINGS)
    except (OSError, ValueError) as error:
        errors.append(f"settings.json: not valid JSON ({type(error).__name__}); using defaults")
        return dict(DEFAULT_SETTINGS)
    settings = dict(DEFAULT_SETTINGS)
    if isinstance(data, dict):
        if isinstance(data.get("keyboards"), list) and all(isinstance(k, str) for k in data["keyboards"]):
            settings["keyboards"] = data["keyboards"]
        if isinstance(data.get("theme"), str):
            settings["theme"] = data["theme"]
        for flag in ("haptics", "suggestions"):
            if isinstance(data.get(flag), bool):
                settings[flag] = data[flag]
        options = clean_keyboard_options(data.get("keyboardOptions"))
        if options is not None:
            settings["keyboardOptions"] = options
    return settings


MAX_EMOJI_LIST = 40
TONES = ("", "light", "medium-light", "medium", "medium-dark", "dark")


def load_emoji(dirs: list[Path], errors: list[str]) -> Optional[dict]:
    """The emoji picker data (emoji/emoji.data, JSON): the user's copy first, then the bundled one."""
    for directory in dirs:
        path = directory / "emoji" / "emoji.data"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        except (OSError, ValueError) as error:
            errors.append(f"emoji/emoji.data: not valid JSON ({type(error).__name__})")
            continue
        if isinstance(data, dict) and isinstance(data.get("groups"), list):
            return {"groups": data["groups"]}
        errors.append("emoji/emoji.data: no groups")
    return None


def clean_emoji_state(data: object) -> dict:
    """Recent and favorites (emoji, or Steam item keys like "steam:sticker:<name>") and the skin tone; anything else is dropped."""
    data = data if isinstance(data, dict) else {}
    pick = lambda key: [e for e in data.get(key, []) if isinstance(e, str) and 0 < len(e) <= 96][:MAX_EMOJI_LIST] \
        if isinstance(data.get(key), list) else []
    tone = data.get("tone") if data.get("tone") in TONES else ""
    return {"recent": pick("recent"), "favorites": pick("favorites"), "tone": tone}


def load_emoji_state(path: Path) -> dict:
    try:
        return clean_emoji_state(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return clean_emoji_state(None)


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def save_settings(path: Path, changes: dict) -> None:
    """Merge changes into settings.json, keeping other fields; written atomically."""
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(current, dict):
            current = {}
    except (OSError, ValueError):
        current = {}
    current.update(changes)
    write_json(path, current)


MAX_EXTENDS = 4  # how deep "extends" may chain
NOT_INHERITED = ("id", "name", "description", "extends", "rows")


def _extend(layouts: dict, layout_id: str, errors: list[str], done: dict[str, Optional[dict]],
            chain: tuple[str, ...] = ()) -> Optional[dict]:
    """The layout with what it extends filled in, or None (reported once) if that cannot be done."""
    if layout_id in done:
        return done[layout_id]
    done[layout_id] = _extend_one(layouts, layout_id, errors, done, chain)
    return done[layout_id]


def _extend_one(layouts: dict, layout_id: str, errors: list[str], done: dict[str, Optional[dict]],
                chain: tuple[str, ...]) -> Optional[dict]:
    layout = layouts[layout_id]
    base_id = layout.get("extends")
    if base_id is None:
        if not isinstance(layout.get("rows"), list):
            errors.append(f"{layout_id}: needs rows (a list), or extends")
            return None
        return layout
    if base_id in chain or base_id == layout_id or len(chain) >= MAX_EXTENDS:
        errors.append(f"{layout_id}: extends {base_id} in a loop or too deep")
        return None
    if base_id not in layouts:
        errors.append(f"{layout_id}: extends {base_id}, which was not found")
        return None
    base = _extend(layouts, base_id, errors, done, chain + (layout_id,))
    if base is None:
        return None
    rows = [list(row) for row in base["rows"]]
    own = layout.get("rows", {})
    if isinstance(own, list):
        rows = own
    else:
        for index, row in own.items():
            if int(index) >= len(rows):
                errors.append(f"{layout_id}: row {index} replaces nothing ({base_id} has {len(rows)} rows)")
                return None
            rows[int(index)] = row
    inherited = {k: json.loads(json.dumps(v)) for k, v in base.items() if k not in NOT_INHERITED}
    own_fields = {k: v for k, v in layout.items() if k not in ("extends", "rows")}
    return {**inherited, **own_fields, "rows": rows}


def _key_id(key: Any) -> str:
    """What a key does, as the page tells keys apart (data-k): the two halves of a two-row key match."""
    if not isinstance(key, dict):
        return str(key)
    field = {"char": "char", "key": "key", "mod": "mod", "action": "action"}.get(key.get("type", ""))
    if field:
        return str(key.get(field, ""))
    return str(key["flick"][0]) if key.get("type") == "flick" and key.get("flick") else ""


def _width(key: Any) -> float:
    return key.get("w", 1) if isinstance(key, dict) else 1


def _expand_spans(layout_id: str, layout: dict, errors: list[str]) -> bool:
    """Split each two-row key ("rows": 2, written once in the upper row) into the halves the page draws:
    "tall": "top" there, and "tall": "bottom" in the row below at the same columns, "notch" narrower on
    the left (the JIS Enter). False (reported) when the row below has no room there."""
    rows = [list(row) for row in layout["rows"]]
    for index, row in enumerate(rows):
        at = 0.0
        for position, key in enumerate(row):
            width = _width(key)
            if isinstance(key, dict) and key.get("rows") == 2:
                notch = key.get("notch", 0)
                below = rows[index + 1] if index + 1 < len(rows) else None
                start, x, slot = at + notch, 0.0, None
                for place in range(len(below) + 1 if below is not None else 0):
                    if abs(x - start) < 1e-6:
                        slot = place
                        break
                    if place < len(below):
                        x += _width(below[place])
                if below is None or slot is None or notch >= width:
                    errors.append(f"{layout_id}: row {index}: {_key_id(key)} is two rows high but the row below has no room for it")
                    return False
                top = {k: v for k, v in key.items() if k != "rows"}
                bottom = {k: v for k, v in key.items() if k not in ("rows", "notch")}
                row[position] = {**top, "tall": "top"}
                below.insert(slot, {**bottom, "w": width - notch, "tall": "bottom"})
            at += width
    layout["rows"] = rows
    return True


def _check_rows(layout_id: str, layout: dict, errors: list[str]) -> None:
    """Report rows that are not all as wide as the first."""
    widths = [sum(_width(key) for key in row) for row in layout["rows"]]
    for index, width in enumerate(widths[1:], start=1):
        if abs(width - widths[0]) > 1e-6:
            errors.append(f"{layout_id}: row {index} is {width:g} wide, row 0 is {widths[0]:g}")


def _resolve_layouts(catalog: dict, errors: list[str]) -> None:
    """Fill in what a layout leaves to defaults or to other packs, so the page gets every layout complete."""
    layouts = catalog["layouts"]
    done: dict[str, Optional[dict]] = {}
    resolved = {layout_id: _extend(layouts, layout_id, errors, done) for layout_id in layouts}
    catalog["layouts"] = layouts = {k: v for k, v in resolved.items() if v is not None}
    for layout_id, layout in layouts.items():
        layout.setdefault("toolbar", [dict(key) for key in DEFAULT_TOOLBAR])
        if isinstance(layout.get("modify"), str):
            table = catalog["tables"].get(layout["modify"], {})
            if "cycles" in table:
                layout["modify"] = list(table["cycles"])
            else:
                errors.append(f"{layout_id}: modify table {layout['modify']} not found")
                del layout["modify"]
        _expand_spans(layout_id, layout, errors)
        _check_rows(layout_id, layout, errors)
        has_modify_key = any(isinstance(key, dict) and key.get("action") == "modify" for row in layout["rows"] for key in row)
        if has_modify_key and not layout.get("modify"):
            errors.append(f"{layout_id}: has a ゛゜小 key but no modify table")


def _check_tables(catalog: dict, errors: list[str]) -> None:
    """A table is either entries (romaji) or cycles (゛゜小)."""
    for table_id, table in list(catalog["tables"].items()):
        if ("entries" in table) == ("cycles" in table):
            errors.append(f"{table_id}: needs entries or cycles (one of them)")
            del catalog["tables"][table_id]


def _extend_keyboards(keyboards: dict, errors: list[str]) -> dict:
    """Keyboards with what they extend filled in: the base's fields, each replaced by the keyboard's own
    (options as a whole); the name and description are never inherited. Reported and dropped: a missing
    base, a loop, and a keyboard with no layout."""
    done: dict[str, Optional[dict]] = {}

    def resolve(keyboard_id: str, chain: tuple[str, ...]) -> Optional[dict]:
        if keyboard_id in done:
            return done[keyboard_id]
        keyboard = keyboards[keyboard_id]
        base_id = keyboard.get("extends")
        result: Optional[dict] = keyboard
        if base_id is not None:
            if base_id in chain or base_id == keyboard_id or len(chain) >= MAX_EXTENDS:
                errors.append(f"{keyboard_id}: extends {base_id} in a loop or too deep")
                result = None
            elif base_id not in keyboards:
                errors.append(f"{keyboard_id}: extends {base_id}, which was not found")
                result = None
            else:
                base = resolve(base_id, chain + (keyboard_id,))
                inherited = {k: json.loads(json.dumps(v)) for k, v in (base or {}).items() if k not in ("id", "name", "description", "extends")}
                result = None if base is None else {**inherited, **{k: v for k, v in keyboard.items() if k != "extends"}}
        if result is not None and "layout" not in result:
            errors.append(f"{keyboard_id}: needs a layout, or extends a keyboard with one")
            result = None
        done[keyboard_id] = result
        return result

    resolved = {keyboard_id: resolve(keyboard_id, ()) for keyboard_id in keyboards}
    return {k: v for k, v in resolved.items() if v is not None}


def _pages(keyboard: dict) -> list[str]:
    """Every layout a keyboard can show: its layout, its 英数 page(s) and its symbols pages."""
    pages = keyboard.get("pages", {})
    latin = pages.get("latin")
    latins = [latin["flick"], latin["qwerty"]] if isinstance(latin, dict) else [latin] if latin else []
    return [keyboard["layout"], *latins, *pages.get("symbols", [])]


def load(bundled: Path, schema_path: Path, user: Optional[Path] = None) -> dict:
    """The boot data for the page: {catalog, settings, errors}."""
    errors: list[str] = []
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"catalog": {kind: {} for kind in KINDS.values()}, "settings": dict(DEFAULT_SETTINGS),
                "errors": [f"cannot read the pack schema {schema_path}"]}
    user = user or user_dir()
    items = _scan(bundled, schema, errors)
    items.update(_scan(user / "packs", schema, errors))  # user items replace bundled ones by id

    catalog: dict[str, dict] = {kind: {} for kind in KINDS.values()}
    for item_id, item in items.items():
        catalog[KINDS[item["kind"]]][item_id] = item
    _check_tables(catalog, errors)
    _resolve_layouts(catalog, errors)
    catalog["keyboards"] = _extend_keyboards(catalog["keyboards"], errors)
    for keyboard_id, keyboard in list(catalog["keyboards"].items()):
        missing = [lay for lay in _pages(keyboard) if lay not in catalog["layouts"]]
        if missing:
            errors.append(f"{keyboard_id}: layout {missing[0]} not found")
            del catalog["keyboards"][keyboard_id]
        elif (keyboard.get("composer") == "romaji" or "romajiInput" in keyboard.get("options", {})) \
                and "entries" not in catalog["tables"].get(keyboard.get("table"), {}):
            errors.append(f"{keyboard_id}: romaji table {keyboard.get('table')} not found")
            del catalog["keyboards"][keyboard_id]
        elif "swipe" in keyboard.get("options", {}) and "swipe" not in keyboard.get("features", {}):
            errors.append(f"{keyboard_id}: the swipe option needs features.swipe")  # the keyboard still types
            del keyboard["options"]["swipe"]

    settings = load_settings(user / "settings.json", errors)
    unknown = [k for k in settings["keyboards"] if k not in catalog["keyboards"]]
    if unknown:
        errors.append(f"settings.json: unknown keyboards {', '.join(unknown)}")
    settings["keyboards"] = [k for k in settings["keyboards"] if k in catalog["keyboards"]] \
        or sorted(catalog["keyboards"])[:1]
    if settings["theme"] not in catalog["themes"]:
        errors.append(f"settings.json: unknown theme {settings['theme']}")
        default = DEFAULT_SETTINGS["theme"]
        settings["theme"] = default if default in catalog["themes"] else next(iter(sorted(catalog["themes"])), "")
    emoji = load_emoji([user / "packs", bundled], errors)
    return {"catalog": catalog, "settings": settings, "errors": errors,
            "emoji": emoji, "emojiState": load_emoji_state(user / "emoji.json")}


if __name__ == "__main__":
    # The resolved catalog of bundled packs, as the page gets it (no user packs or settings), for tests
    # and tools: python3 -m polykey.packs <packs dir> <schema>
    import sys
    import tempfile

    with tempfile.TemporaryDirectory() as empty:
        result = load(Path(sys.argv[1]), Path(sys.argv[2]), user=Path(empty))
    json.dump({"catalog": result["catalog"], "errors": result["errors"]}, sys.stdout, ensure_ascii=False)
