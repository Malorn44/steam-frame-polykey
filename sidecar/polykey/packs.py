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
KINDS = {"layout": "layouts", "keyboard": "keyboards", "theme": "themes"}
DEFAULT_SETTINGS = {"keyboards": ["en/english", "ja/12key"], "theme": "themes/steam", "haptics": True, "suggestions": True}
# Per-keyboard options the page may set (settings.json "keyboardOptions": {keyboard id: {option: bool}}).
KEYBOARD_OPTIONS = ("tapCycle",)


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
        for name, item in value.items():
            if name in properties:
                errors += validate(item, properties[name], root, f"{path}/{name}")
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
    for keyboard_id, keyboard in list(catalog["keyboards"].items()):
        if keyboard["layout"] not in catalog["layouts"]:
            errors.append(f"{keyboard_id}: layout {keyboard['layout']} not found")
            del catalog["keyboards"][keyboard_id]

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
