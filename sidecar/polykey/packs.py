"""Load and validate packs (layouts, keyboards, themes, tables, picker sets, languages) and the user's settings.

Bundled packs come first; a user pack in ~/.config/polykey/packs/ replaces the bundled item with the
same id. Files are validated against packs/pack.schema.json with a small stdlib validator for the
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
KINDS = {"layout": "layouts", "keyboard": "keyboards", "theme": "themes", "table": "tables", "language": "languages"}
DEFAULT_SETTINGS = {
    "keyboards": ["en/english"],
    "theme": "themes/steam",
    "haptics": True,
    "suggestions": True,
    "dictation": False,
    "dictationModels": {},
    "dictationContinuous": False,
    "autoUpdate": True,
}
# The model dictation uses per language (settings.json "dictationModels": {language: model id}).
DICTATION_LANGUAGE = re.compile(r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$")
# The language codes a name may be written in (pack.schema.json's "name" has the same pattern).
LANGUAGE_CODE = re.compile(r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*\Z")
DICTATION_MODEL = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
# Per-keyboard options the page may set (settings.json "keyboardOptions": {keyboard id: {option: bool}}).
# dictationCommit, on a keyboard with a reading: dictated text is typed at once instead of going into the
# reading for its candidates.
KEYBOARD_OPTIONS = (
    "tapCycle",
    "candidatesLeft",
    "flickHints",
    "romajiInput",
    "qwertyLatin",
    "swipe",
    "dictationCommit",
)


# The strip above the keys, for a layout that does not set its own ("toolbar": [] means none).
DEFAULT_TOOLBAR = [
    {"type": "action", "action": a} for a in ("settings", "emoji", "dictate", "copy", "cut", "paste", "menu", "hide")
]


MAX_KEYBOARDS = 20
KEYBOARD_ID = re.compile(r"^[a-z0-9-]+/[a-z0-9-]+$")


def clean_keyboard_list(value: object) -> bool:
    """Whether a keyboards list from the page is sane: 1-20 distinct ids."""
    return (
        isinstance(value, list)
        and 0 < len(value) <= MAX_KEYBOARDS
        and len(set(value)) == len(value)
        and all(isinstance(k, str) and KEYBOARD_ID.match(k) for k in value)
    )


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


def clean_dictation_models(value: object) -> Optional[dict]:
    """{language: model id}, or None when it is not that shape (unknown ids are ignored later)."""
    if not isinstance(value, dict) or len(value) > 64:
        return None
    if not all(
        isinstance(k, str) and DICTATION_LANGUAGE.match(k) and isinstance(v, str) and DICTATION_MODEL.match(v)
        for k, v in value.items()
    ):
        return None
    return dict(value)


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
        meant = [
            r
            for r in results
            if not any(e.startswith(tags) for e in r) and not (len(r) == 1 and r[0].startswith(wrong_type))
        ]
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
        if len(value) < schema.get("minProperties", 0):
            errors.append(f"{where}: needs at least {schema['minProperties']} entries (it has {len(value)})")
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


class DuplicateKey(ValueError):
    """A JSON object names the same key twice; json.loads would quietly keep the last one."""


def _no_duplicates(pairs: list[tuple[str, object]]) -> dict:
    obj: dict = {}
    for key, value in pairs:
        if key in obj:
            raise DuplicateKey(key)
        obj[key] = value
    return obj


def read_json(text: str) -> object:
    """JSON as json.loads reads it, except that a key twice in one object is an error (DuplicateKey)."""
    return json.loads(text, object_pairs_hook=_no_duplicates)


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
            data = read_json(file.read_text(encoding="utf-8"))
        except DuplicateKey as error:
            errors.append(f'{name}: "{str(error.args[0])[:40]}" appears twice in one object')
            continue
        except (OSError, ValueError) as error:
            errors.append(f"{name}: not valid JSON ({type(error).__name__})")
            continue
        problems = validate(data, schema, schema)
        if not problems and data["id"].split("/")[0] != file.parent.name:
            # A language's id is its code alone: the folder is named after it.
            wanted = f"start with {file.parent.name}/" if "/" in data["id"] else f"be {file.parent.name}"
            problems = [f"/id: must {wanted} (the folder name)"]
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
        for flag in ("haptics", "suggestions", "dictation", "dictationContinuous", "autoUpdate"):
            if isinstance(data.get(flag), bool):
                settings[flag] = data[flag]
        options = clean_keyboard_options(data.get("keyboardOptions"))
        if options is not None:
            settings["keyboardOptions"] = options
        models = clean_dictation_models(data.get("dictationModels"))
        if models is not None:
            settings["dictationModels"] = models
    return settings


MAX_EMOJI_LIST = 40
TONES = ("", "light", "medium-light", "medium", "medium-dark", "dark")


# --- picker sets ---------------------------------------------------------------------------------

MAX_PICKER_SETS = 16
MAX_PICKER_ITEMS = 4000
# Sections the picker draws itself: a category cannot take their ids.
PICKER_OWN_SECTION = re.compile(r"^(recent|favorites)\Z")


def _picker_problem(item: dict) -> Optional[str]:
    """What is wrong with a picker set that the schema cannot say, or None."""
    needs_recent = next((f for f in ("recentBin", "favorites") if item.get(f) and not item.get("recent")), None)
    if needs_recent is not None:
        return f"{needs_recent} needs recent"
    own = next((c["id"] for c in item["categories"] if PICKER_OWN_SECTION.match(c["id"])), None)
    return f"category {own}: that id is the picker's own" if own is not None else _category_twice(item)


def _category_twice(item: dict) -> Optional[str]:
    ids = [category["id"] for category in item["categories"]]
    twice = next((i for i in ids if ids.count(i) > 1), None)
    return f"category {twice} is defined twice" if twice is not None else None


def _merge_picker(bundled: dict, mine: dict) -> dict:
    """A user's set over the bundled one with its id: the user's fields over the bundled ones, and the
    bundled categories, each one the user also has replaced in place and the user's others after them."""
    own = {category["id"]: category for category in mine["categories"]}
    kept = [own.pop(category["id"], category) for category in bundled["categories"]]
    return {**bundled, **mine, "categories": kept + list(own.values())}


def _data_groups(path: Path) -> Any:
    """A data file's groups as {id: items}; None when there is no file, or what is wrong with it."""
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return f"larger than {MAX_FILE_BYTES // 1024} KiB"
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        return f"not valid JSON ({type(error).__name__})"
    groups = data.get("groups") if isinstance(data, dict) else None
    if not isinstance(groups, list) or not all(isinstance(g, dict) and isinstance(g.get("id"), str) for g in groups):
        return "no groups"
    return {group["id"]: group.get("items") for group in groups}


class _DataFiles:
    """Items kept in data files (<namespace>/<name>.data): the user's copy first, then the bundled one.
    Each file is read once and each group checked once, however many categories name them."""

    def __init__(self, dirs: list[Path], schema: dict, errors: list[str]):
        self._dirs, self._schema, self._errors = dirs, schema, errors
        self._groups: dict[Path, Any] = {}
        self._items: dict[tuple[Path, str], Optional[list]] = {}

    def items(self, name: str, group: str) -> Optional[list]:
        for directory in self._dirs:
            path = directory / name
            if path not in self._groups:
                self._groups[path] = _data_groups(path)
                if isinstance(self._groups[path], str):
                    self._errors.append(f"{name}: {self._groups[path]}")
            groups = self._groups[path]
            if not isinstance(groups, dict) or group not in groups:
                continue
            if (path, group) not in self._items:
                problems = validate(groups[group], {"$ref": "#/$defs/pickerItems"}, self._schema, f"/{group}")
                if problems:
                    self._errors.append(f"{name}: {problems[0]}")
                self._items[(path, group)] = None if problems else groups[group]
            if self._items[(path, group)] is not None:
                return self._items[(path, group)]
        return None


def _resolve_picker(item: dict, files: _DataFiles, errors: list[str]) -> Optional[dict]:
    """The set with every category's items listed (those kept in a data file read from it), or None
    (reported) when the set cannot be shown. A category whose data is missing is left out, reported."""
    problem = _picker_problem(item)
    categories = []
    for category in [] if problem else item["categories"]:
        items = category["items"]
        if isinstance(items, dict) and "steam" in items:
            categories.append({**category, "steam": items["steam"], "items": []})  # the page asks Steam
            continue
        if isinstance(items, dict):
            group = items.get("group", category["id"])
            found = files.items(items["file"], group)
            if found is None:
                errors.append(f"{item['id']}: category {category['id']}: no group {group} in {items['file']}")
                continue
            items = found
        categories.append({**category, "items": items})
    if not problem and len(categories) > 64:
        problem = "more than 64 categories"
    if not problem and sum(len(category["items"]) for category in categories) > MAX_PICKER_ITEMS:
        problem = f"more than {MAX_PICKER_ITEMS} items"
    if not problem and not categories:
        problem = "no categories"
    if problem:
        errors.append(f"{item['id']}: {problem}")
        return None
    return {**item, "categories": categories}


def _load_pickers(bundled: dict, mine: dict, files: _DataFiles, errors: list[str]) -> list[dict]:
    """The picker sets in pack order: the bundled ones, then the user's new ones. A user's set with a
    bundled one's id is laid over it; if that cannot be shown, the bundled one is, as it was."""
    sets = []
    for set_id in [*bundled, *(i for i in mine if i not in bundled)]:
        tries = [bundled[set_id]] if set_id in bundled else []
        if set_id in mine:
            own = _category_twice(mine[set_id])  # laid over the bundled set, a second one would be lost
            if own:
                errors.append(f"{set_id}: {own}")
            else:
                tries.insert(0, _merge_picker(tries[0], mine[set_id]) if tries else mine[set_id])
        resolved = next((r for r in (_resolve_picker(t, files, errors) for t in tries) if r is not None), None)
        if resolved is not None:
            sets.append(resolved)
    if len(sets) > MAX_PICKER_SETS:
        errors.append(
            f"more than {MAX_PICKER_SETS} picker sets: {', '.join(s['id'] for s in sets[MAX_PICKER_SETS:])} left out"
        )
    return sets[:MAX_PICKER_SETS]


def _picker_text(item: Any, tones: bool) -> Any:
    """An item as the page gets it: its text; an emoji with skin tones keeps them only in a set that offers them."""
    if isinstance(item, dict):
        return item["text"]
    return item if tones or isinstance(item, str) else item[0]


def pickers_for_page(sets: list[dict]) -> list[dict]:
    """What the page gets of the picker sets: each item as its text, without readings and tags."""
    return [
        {
            **{k: v for k, v in s.items() if k not in ("kind", "schemaVersion", "description")},
            "categories": [
                {**c, "items": [_picker_text(item, s.get("tones", False)) for item in c["items"]]}
                for c in s["categories"]
            ],
        }
        for s in sets
    ]


# The picker sets as last loaded, readings and tags included: the page is sent only the texts.
_pickers: list[dict] = []


def loaded_pickers() -> list[dict]:
    """The picker sets from the last load(), in pack order, each item as its pack wrote it."""
    return _pickers


MAX_STATE_ENTRY = 96
EMOJI_SET, KAOMOJI_SET = "emoji/emoji", "emoji/kaomoji"


def clean_emoji_state(data: object) -> dict:
    """The picker's state: Recent for each set ({set id: [...]}), the favorites (emoji, or Steam item keys
    like "steam:sticker:<name>"), the skin tone and the set last shown ("" for the first); anything else
    is dropped. A state from before sets were packs still reads: its one recent list is the emoji set's,
    kaomojiRecent the kaomoji set's, and mode the set last shown."""
    data = data if isinstance(data, dict) else {}
    pick = lambda value: (
        [e for e in value if isinstance(e, str) and 0 < len(e) <= MAX_STATE_ENTRY][:MAX_EMOJI_LIST]
        if isinstance(value, list)
        else []
    )
    recent, shown = data.get("recent"), data.get("set")
    if isinstance(recent, list) or "kaomojiRecent" in data or "mode" in data:
        recent = {EMOJI_SET: recent, KAOMOJI_SET: data.get("kaomojiRecent")}
        shown = {"emoji": EMOJI_SET, "kaomoji": KAOMOJI_SET}.get(str(data.get("mode")), "")
    recent = recent if isinstance(recent, dict) else {}
    sets = [s for s in recent if isinstance(s, str) and KEYBOARD_ID.match(s) and len(s) <= 80][:MAX_PICKER_SETS]
    return {
        "recent": {s: pick(recent[s]) for s in sets if pick(recent[s])},
        "favorites": pick(data.get("favorites")),
        "tone": data.get("tone") if data.get("tone") in TONES else "",
        "set": shown if isinstance(shown, str) and KEYBOARD_ID.match(shown) and len(shown) <= 80 else "",
    }


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


def read_settings(path: Optional[Path]) -> dict:
    """settings.json as it is, or {} when it is missing, unreadable or not an object."""
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path else {}
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_settings(path: Path, changes: dict) -> None:
    """Merge changes into settings.json, keeping other fields; written atomically."""
    write_json(path, {**read_settings(path), **changes})


MAX_EXTENDS = 4  # how deep "extends" may chain
NOT_INHERITED = ("id", "name", "description", "extends", "rows")


def _extend(
    layouts: dict, layout_id: str, errors: list[str], done: dict[str, Optional[dict]], chain: tuple[str, ...] = ()
) -> Optional[dict]:
    """The layout with what it extends filled in, or None (reported once) if that cannot be done."""
    if layout_id in done:
        return done[layout_id]
    done[layout_id] = _extend_one(layouts, layout_id, errors, done, chain)
    return done[layout_id]


def _extend_one(
    layouts: dict, layout_id: str, errors: list[str], done: dict[str, Optional[dict]], chain: tuple[str, ...]
) -> Optional[dict]:
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
    """Split each key two or three rows high ("rows": 2 or 3, written once in the top row) into the pieces
    the page draws: "tall": "top" there ("span": its rows), "middle" and "bottom" in the rows below at the
    same columns, "notch" narrower on the left (the JIS Enter). False (reported) when a row below has no
    room there."""
    rows = [list(row) for row in layout["rows"]]
    for index, row in enumerate(rows):
        at = 0.0
        for position, key in enumerate(row):
            width = _width(key)
            span = key.get("rows") if isinstance(key, dict) else None
            if span in (2, 3):
                notch = key.get("notch", 0)
                piece = {k: v for k, v in key.items() if k not in ("rows", "notch")}
                for depth in range(1, span):
                    below = rows[index + depth] if index + depth < len(rows) else None
                    start, x, slot = at + notch, 0.0, None
                    for place in range(len(below) + 1 if below is not None else 0):
                        if abs(x - start) < 1e-6:
                            slot = place
                            break
                        if place < len(below):
                            x += _width(below[place])
                    if below is None or slot is None or notch >= width:
                        where = (
                            f"there is no row {index + depth}"
                            if below is None
                            else f"row {index + depth} has no room for it"
                        )
                        errors.append(f"{layout_id}: row {index}: {_key_id(key)} is {span} rows high but {where}")
                        return False
                    below.insert(
                        slot, {**piece, "w": width - notch, "tall": "bottom" if depth == span - 1 else "middle"}
                    )
                row[position] = {**{k: v for k, v in key.items() if k != "rows"}, "tall": "top", "span": span}
            at += width
    layout["rows"] = rows
    return True


def _check_rows(layout_id: str, layout: dict, errors: list[str], width: Optional[float] = None) -> bool:
    """Report rows that are not all as wide as the first (or as `width`); False if any."""
    widths = [sum(_width(key) for key in row) for row in layout["rows"]]
    want = widths[0] if width is None else width
    ok = True
    for index, row_width in enumerate(widths):
        if abs(row_width - want) > 1e-6:
            errors.append(
                f"{layout_id}: row {index} is {row_width:g} wide, {'row 0 is' if width is None else 'the layout is'} {want:g}"
            )
            ok = False
    return ok


def _is_globe(key: Any) -> bool:
    return isinstance(key, dict) and key.get("type") == "action" and key.get("action") == "next-keyboard"


def _alone_rows(layout_id: str, layout: dict, errors: list[str]) -> Optional[list]:
    """The rows shown when 🌐 has nowhere to go (one keyboard in your list): 🌐 left out and each key's
    "alone" patch (w, rows) applied. If those rows do not fit (a pack without patches), 🌐 becomes a gap
    of its width instead, reported. None for a layout without 🌐."""
    rows = layout["rows"]
    if not any(_is_globe(key) for row in rows for key in row):
        return None
    patched = [[_patched(key) for key in row if not _is_globe(key)] for row in rows]
    trial: list[str] = []
    alone = {"rows": patched}
    width = sum(_width(key) for key in layout["rows"][0])
    if _expand_spans(layout_id, alone, trial) and _check_rows(layout_id, alone, trial, width):
        return alone["rows"]
    errors.extend(f"{e} (with one keyboard; 🌐 left as a gap)" for e in trial)
    gap = {
        "rows": [
            [{"type": "gap", "w": _width(key)} if _is_globe(key) else _without_alone(key) for key in row]
            for row in rows
        ]
    }
    _expand_spans(layout_id, gap, [])
    return gap["rows"]


def _patched(key: Any) -> Any:
    """A key with its "alone" patch applied ("rows": 1 makes a tall key one row high)."""
    if not isinstance(key, dict):
        return key
    out = {**_without_alone(key), **key.get("alone", {})}
    if out.get("rows") == 1:
        del out["rows"]
    return out


def _without_alone(key: Any) -> Any:
    return {k: v for k, v in key.items() if k != "alone"} if isinstance(key, dict) else key


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
        alone = _alone_rows(layout_id, layout, errors)
        layout["rows"] = [[_without_alone(key) for key in row] for row in layout["rows"]]
        _expand_spans(layout_id, layout, errors)
        _check_rows(layout_id, layout, errors)
        if alone is not None:
            layout["aloneRows"] = alone
        has_modify_key = any(
            isinstance(key, dict) and key.get("action") == "modify" for row in layout["rows"] for key in row
        )
        if has_modify_key and not layout.get("modify"):
            errors.append(f"{layout_id}: has a ゛゜小 key but no modify table")


# What a table holds: one of these.
TABLE_DATA = ("entries", "cycles", "hangul")
# The table each composer reads, and what it is called in an error (src/core/composers/).
COMPOSER_TABLES = {"romaji": ("entries", "romaji"), "hangul": ("hangul", "hangul")}


def _check_tables(catalog: dict, errors: list[str]) -> None:
    """A table is entries (romaji), cycles (゛゜小) or hangul (how jamo compose): one of them."""
    for table_id, table in list(catalog["tables"].items()):
        if sum(f in table for f in TABLE_DATA) != 1:
            errors.append(f"{table_id}: needs entries, cycles or hangul (one of them)")
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
                inherited = {
                    k: json.loads(json.dumps(v))
                    for k, v in (base or {}).items()
                    if k not in ("id", "name", "description", "extends")
                }
                result = (
                    None if base is None else {**inherited, **{k: v for k, v in keyboard.items() if k != "extends"}}
                )
        if result is not None and "layout" not in result:
            errors.append(f"{keyboard_id}: needs a layout, or extends a keyboard with one")
            result = None
        done[keyboard_id] = result
        return result

    resolved = {keyboard_id: resolve(keyboard_id, ()) for keyboard_id in keyboards}
    return {k: v for k, v in resolved.items() if v is not None}


def _table_needed(keyboard: dict) -> Optional[tuple[str, str]]:
    """What the keyboard's table must hold for its composer (a kana keyboard's romajiInput: romaji), or None."""
    if keyboard.get("composer") in COMPOSER_TABLES:
        return COMPOSER_TABLES[keyboard["composer"]]
    return COMPOSER_TABLES["romaji"] if "romajiInput" in keyboard.get("options", {}) else None


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
        return {
            "catalog": {kind: {} for kind in KINDS.values()},
            "settings": dict(DEFAULT_SETTINGS),
            "errors": [f"cannot read the pack schema {schema_path}"],
        }
    user = user or user_dir()
    items = _scan(bundled, schema, errors)
    mine = _scan(user / "packs", schema, errors)
    is_picker = lambda found: {item_id: item for item_id, item in found.items() if item["kind"] == "picker"}
    global _pickers
    _pickers = _load_pickers(
        is_picker(items), is_picker(mine), _DataFiles([user / "packs", bundled], schema, errors), errors
    )
    items.update(mine)  # user items replace bundled ones by id

    catalog: dict[str, dict] = {kind: {} for kind in KINDS.values()}
    for item_id, item in items.items():
        if item["kind"] in KINDS:
            catalog[KINDS[item["kind"]]][item_id] = item
    _check_tables(catalog, errors)
    _resolve_layouts(catalog, errors)
    catalog["keyboards"] = _extend_keyboards(catalog["keyboards"], errors)
    for keyboard_id, keyboard in list(catalog["keyboards"].items()):
        missing = [lay for lay in _pages(keyboard) if lay not in catalog["layouts"]]
        table = _table_needed(keyboard)
        if missing:
            errors.append(f"{keyboard_id}: layout {missing[0]} not found")
            del catalog["keyboards"][keyboard_id]
        elif table and table[0] not in catalog["tables"].get(keyboard.get("table"), {}):
            errors.append(f"{keyboard_id}: {table[1]} table {keyboard.get('table')} not found")
            del catalog["keyboards"][keyboard_id]
        elif "swipe" in keyboard.get("options", {}) and "swipe" not in keyboard.get("features", {}):
            errors.append(f"{keyboard_id}: the swipe option needs features.swipe")  # the keyboard still types
            del keyboard["options"]["swipe"]

    settings = load_settings(user / "settings.json", errors)
    unknown = [k for k in settings["keyboards"] if k not in catalog["keyboards"]]
    if unknown:
        errors.append(f"settings.json: unknown keyboards {', '.join(unknown)}")
    settings["keyboards"] = [k for k in settings["keyboards"] if k in catalog["keyboards"]] or sorted(
        catalog["keyboards"]
    )[:1]
    if settings["theme"] not in catalog["themes"]:
        errors.append(f"settings.json: unknown theme {settings['theme']}")
        default = DEFAULT_SETTINGS["theme"]
        settings["theme"] = default if default in catalog["themes"] else next(iter(sorted(catalog["themes"])), "")
    return {
        "catalog": catalog,
        "settings": settings,
        "errors": errors,
        "pickers": pickers_for_page(_pickers),
        "emojiState": load_emoji_state(user / "emoji.json"),
    }


if __name__ == "__main__":
    # The resolved catalog of bundled packs, as the page gets it (no user packs or settings), for tests
    # and tools: python3 -m polykey.packs <packs dir> <schema>
    import sys
    import tempfile

    with tempfile.TemporaryDirectory() as empty:
        result = load(Path(sys.argv[1]), Path(sys.argv[2]), user=Path(empty))
    shown = {"catalog": result["catalog"], "pickers": result["pickers"], "errors": result["errors"]}
    json.dump(shown, sys.stdout, ensure_ascii=False)
