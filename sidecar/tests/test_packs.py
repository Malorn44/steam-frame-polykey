from __future__ import annotations

import io
import json
from pathlib import Path

from polykey import packs
from polykey.injector import Config, Log, boot_script

REPO = Path(__file__).resolve().parents[2]
SCHEMA = REPO / "packs" / "pack.schema.json"
BUNDLED = REPO / "packs"


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


def test_bundled_packs_are_valid(tmp_path):
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["errors"] == []
    assert set(boot["catalog"]["layouts"]) == {
        "en/qwerty",
        "internal/emoji-row",
        "ja/flick",
        "ja/flick-abc",
        "ja/flick-qwerty",
        "ja/flick-symbols",
        "ja/flick-symbols2",
        "ja/gojuon",
        "ja/kana-jis",
        "ja/qwerty-romaji",
        "ko/dubeolsik",
        "ko/qwerty",
    }
    assert set(boot["catalog"]["tables"]) == {"ja/modify", "ja/romaji-table", "ko/hangul"}
    assert boot["settings"] == {
        "keyboards": ["en/english"],
        "theme": "themes/steam",
        "haptics": True,
        "suggestions": True,
        "dictation": False,
        "dictationModels": {},
        "dictationContinuous": False,
        "autoUpdate": True,
    }
    assert "$schema" not in boot["catalog"]["layouts"]["en/qwerty"]


def test_a_key_twice_in_one_object_is_refused(tmp_path):
    user = tmp_path / "config"
    (user / "packs" / "mine").mkdir(parents=True)
    (user / "packs" / "mine" / "t.json").write_text(
        '{"kind": "theme", "id": "mine/t", "name": "T", "name": "U", "colors": {}}', encoding="utf-8"
    )
    boot = packs.load(BUNDLED, SCHEMA, user)
    assert boot["errors"] == ['mine/t.json: "name" appears twice in one object']
    assert "mine/t" not in boot["catalog"]["themes"]


def test_every_json_file_in_the_repo_parses_with_no_key_twice():
    root = REPO
    skip = {"node_modules", "dist", ".venv", "reference", "local", ".git"}
    files = [p for p in root.rglob("*.json") if not skip & set(p.relative_to(root).parts)]
    assert len(files) > 30
    for path in files:
        packs.read_json(path.read_text(encoding="utf-8"))  # raises on bad JSON or a key twice


def test_every_bundled_layout_row_is_15_units(tmp_path):
    layout = packs.load(BUNDLED, SCHEMA, tmp_path)["catalog"]["layouts"]["en/qwerty"]
    widths = [sum(k.get("w", 1) if isinstance(k, dict) else 1 for k in row) for row in layout["rows"]]
    assert widths == [15] * len(widths)


def layout(item_id: str, **fields) -> dict:
    return {
        "schemaVersion": 1,
        "kind": "layout",
        "id": item_id,
        "name": item_id,
        "rows": [[{"type": "char", "char": "a"}]],
        **fields,
    }


def test_a_layout_without_a_toolbar_gets_the_default(tmp_path):
    write(tmp_path / "packs", "mine/plain.json", layout("mine/plain"))
    write(tmp_path / "packs", "mine/bare.json", layout("mine/bare", toolbar=[]))
    layouts = packs.load(BUNDLED, SCHEMA, tmp_path)["catalog"]["layouts"]
    assert layouts["mine/plain"]["toolbar"] == packs.DEFAULT_TOOLBAR
    assert layouts["mine/bare"]["toolbar"] == []


def test_a_layout_names_its_modify_table(tmp_path):
    modify = {"type": "action", "action": "modify"}
    write(tmp_path / "packs", "mine/named.json", layout("mine/named", modify="ja/modify", rows=[[modify]]))
    write(tmp_path / "packs", "mine/own.json", layout("mine/own", modify=["かが"], rows=[[modify]]))
    write(tmp_path / "packs", "mine/lost.json", layout("mine/lost", modify="mine/nope", rows=[[modify]]))
    write(tmp_path / "packs", "mine/none.json", layout("mine/none", rows=[[modify]]))
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    layouts = boot["catalog"]["layouts"]
    assert layouts["mine/named"]["modify"] == boot["catalog"]["tables"]["ja/modify"]["cycles"]
    assert "はばぱ" in layouts["mine/named"]["modify"]
    assert layouts["mine/own"]["modify"] == ["かが"]
    assert "modify" not in layouts["mine/lost"]
    assert "mine/lost: modify table mine/nope not found" in boot["errors"]
    assert "mine/none: has a ゛゜小 key but no modify table" in boot["errors"]


def test_a_layout_extends_another(tmp_path):
    base = layout(
        "mine/base",
        description="the base",
        large=True,
        rows=[[{"type": "char", "char": "a"}], [{"type": "char", "char": "b"}]],
    )
    write(tmp_path / "packs", "mine/base.json", base)
    write(
        tmp_path / "packs",
        "mine/child.json",
        layout("mine/child", extends="mine/base", toolbar=[], rows={"1": [{"type": "char", "char": "c"}]}),
    )
    same = layout("mine/same", extends="mine/child")
    del same["rows"]
    write(tmp_path / "packs", "mine/same.json", same)
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    layouts = boot["catalog"]["layouts"]
    assert boot["errors"] == []
    assert layouts["mine/child"]["rows"] == [[{"type": "char", "char": "a"}], [{"type": "char", "char": "c"}]]
    assert layouts["mine/child"]["large"] is True and "description" not in layouts["mine/child"]
    assert layouts["mine/child"]["name"] == "mine/child" and "extends" not in layouts["mine/child"]
    assert layouts["mine/child"]["toolbar"] == [] and layouts["mine/base"]["toolbar"] == packs.DEFAULT_TOOLBAR
    assert layouts["mine/same"]["rows"] == layouts["mine/child"]["rows"] and layouts["mine/same"]["toolbar"] == []
    assert layouts["mine/base"]["rows"][1] == [{"type": "char", "char": "b"}]  # the base is untouched


def test_a_layout_that_cannot_be_extended_is_reported(tmp_path):
    def child(item_id, **fields):
        return {k: v for k, v in layout(item_id, **fields).items() if k != "rows" or "rows" in fields}

    write(tmp_path / "packs", "mine/lost.json", child("mine/lost", extends="mine/nope"))
    write(tmp_path / "packs", "mine/loop-a.json", child("mine/loop-a", extends="mine/loop-b"))
    write(tmp_path / "packs", "mine/loop-b.json", child("mine/loop-b", extends="mine/loop-a"))
    write(
        tmp_path / "packs",
        "mine/past.json",
        child("mine/past", extends="en/qwerty", rows={"7": [{"type": "char", "char": "x"}]}),
    )
    write(tmp_path / "packs", "mine/rowless.json", child("mine/rowless"))
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert not {"mine/lost", "mine/loop-a", "mine/loop-b", "mine/past", "mine/rowless"} & set(
        boot["catalog"]["layouts"]
    )
    assert "mine/lost: extends mine/nope, which was not found" in boot["errors"]
    assert any(e.startswith("mine/loop-") and "in a loop" in e for e in boot["errors"])
    assert "mine/past: row 7 replaces nothing (en/qwerty has 5 rows)" in boot["errors"]
    assert "mine/rowless: needs rows (a list), or extends" in boot["errors"]
    assert len(boot["errors"]) == 4


def test_rows_must_be_as_wide_as_the_first(tmp_path):
    char = {"type": "char", "char": "a"}
    write(tmp_path / "packs", "mine/even.json", layout("mine/even", rows=[[char, char], [{**char, "w": 2}]]))
    write(tmp_path / "packs", "mine/short.json", layout("mine/short", rows=[[char, char], [char]]))
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["errors"] == ["mine/short: row 1 is 1 wide, row 0 is 2"]
    assert "mine/short" in boot["catalog"]["layouts"]  # reported, still usable


def test_a_two_row_key_is_written_once_and_split_into_halves(tmp_path):
    a = {"type": "char", "char": "a"}
    enter = {"type": "key", "key": "Enter", "w": 1.5, "rows": 2}
    # Same columns below (五十音); and notched, narrower below on the left (the JIS Enter).
    write(tmp_path / "packs", "mine/even.json", layout("mine/even", rows=[[a, enter], [a]]))
    write(
        tmp_path / "packs",
        "mine/jis.json",
        layout("mine/jis", rows=[[a, {**enter, "notch": 0.25}], [a, {**a, "w": 0.25}]]),
    )
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["errors"] == []
    even = boot["catalog"]["layouts"]["mine/even"]["rows"]
    assert even[0][1] == {"type": "key", "key": "Enter", "w": 1.5, "tall": "top", "span": 2}
    assert even[1] == [a, {"type": "key", "key": "Enter", "w": 1.5, "tall": "bottom"}]
    jis = boot["catalog"]["layouts"]["mine/jis"]["rows"]
    assert jis[0][1] == {"type": "key", "key": "Enter", "w": 1.5, "notch": 0.25, "tall": "top", "span": 2}
    assert jis[1][2] == {
        "type": "key",
        "key": "Enter",
        "w": 1.25,
        "tall": "bottom",
    }  # after the 0.25 key under the notch


def test_a_two_row_key_needs_room_below(tmp_path):
    a = {"type": "char", "char": "a"}
    enter = {"type": "key", "key": "Enter", "rows": 2}
    write(tmp_path / "packs", "mine/last.json", layout("mine/last", rows=[[a, a], [a, enter]]))  # no row below
    write(
        tmp_path / "packs",
        "mine/full.json",
        layout("mine/full", rows=[[a, {**a, "w": 0.5}, {**enter, "w": 0.5}], [a, a]]),
    )
    errors = packs.load(BUNDLED, SCHEMA, tmp_path)["errors"]
    assert "mine/last: row 1: Enter is 2 rows high but there is no row 2" in errors
    assert "mine/full: row 0: Enter is 2 rows high but row 1 has no room for it" in errors


def test_a_table_holds_one_of_its_formats(tmp_path):
    table = {"schemaVersion": 1, "kind": "table", "id": "mine/empty", "name": "empty"}
    write(tmp_path / "packs", "mine/empty.json", table)
    write(
        tmp_path / "packs", "mine/two.json", {**table, "id": "mine/two", "cycles": ["はばぱ"], "entries": [["a", "あ"]]}
    )
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert "mine/empty" not in boot["catalog"]["tables"] and "mine/two" not in boot["catalog"]["tables"]
    assert "mine/empty.json: /: needs entries, cycles or hangul (one of them)" in boot["errors"]
    assert "mine/two.json: /: needs entries, cycles or hangul (one of them)" in boot["errors"]


def test_the_schema_lists_each_table_format_once():
    """A format is a table field and one oneOf option (exactly one of them); a composer reads one of them."""
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))["$defs"]
    formats = [option["required"][0] for option in schema["table"]["oneOf"]]
    common = {"$schema", "schemaVersion", "kind", "id", "name", "description"}
    assert formats == [field for field in schema["table"]["properties"] if field not in common]
    assert set(packs.COMPOSER_TABLES) <= set(schema["keyboard"]["properties"]["composer"]["enum"])
    assert set(packs.COMPOSER_TABLES.values()) <= set(formats)


def test_a_user_item_replaces_the_bundled_one(tmp_path):
    write(tmp_path / "packs", "themes/night-owl.json", theme("themes/night-owl", "#123456"))
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["catalog"]["themes"]["themes/night-owl"]["colors"]["surface"] == "#123456"


def test_a_bad_user_file_is_reported_and_the_bundled_item_kept(tmp_path):
    write(tmp_path / "packs", "themes/night-owl.json", theme("themes/night-owl", "blue"))
    write(tmp_path / "packs", "themes/broken.json", "{ not json")
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["catalog"]["themes"]["themes/night-owl"]["colors"]["surface"] == "#011627"
    assert "themes/night-owl.json: /colors/surface: does not match ^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$" in boot["errors"]
    assert "themes/broken.json: not valid JSON (JSONDecodeError)" in boot["errors"]


def test_ids_must_live_in_their_namespace_folder(tmp_path):
    write(tmp_path / "packs", "mine/theme.json", theme("other/theme"))
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["errors"] == ["mine/theme.json: /id: must start with mine/ (the folder name)"]


def test_a_keyboard_needs_its_layout(tmp_path):
    write(
        tmp_path / "packs",
        "fr/azerty.json",
        {"schemaVersion": 1, "kind": "keyboard", "id": "fr/azerty", "name": "Français", "layout": "fr/azerty"},
    )
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert "fr/azerty" not in boot["catalog"]["keyboards"]
    assert boot["errors"] == ["fr/azerty: layout fr/azerty not found"]


def keyboard(item_id: str, **fields) -> dict:
    return {"schemaVersion": 1, "kind": "keyboard", "id": item_id, "name": item_id, **fields}


def test_a_keyboard_extends_another(tmp_path):
    write(
        tmp_path / "packs",
        "ja/mine.json",
        keyboard("ja/mine", extends="ja/12key", layout="ja/gojuon", options={"flickHints": True}),
    )
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["errors"] == []
    mine, base = boot["catalog"]["keyboards"]["ja/mine"], boot["catalog"]["keyboards"]["ja/12key"]
    assert mine["layout"] == "ja/gojuon" and mine["name"] == "ja/mine" and "extends" not in mine
    assert mine["pages"] == base["pages"] and mine["converter"] == "anthy" and mine["language"] == "ja"
    assert mine["options"] == {"flickHints": True}  # options replace the base's as a whole
    assert base["options"]["candidatesLeft"] is True  # the base is untouched


def test_swipe_is_declared_by_the_keyboard_and_switched_by_its_option(tmp_path):
    keyboards = packs.load(BUNDLED, SCHEMA, tmp_path)["catalog"]["keyboards"]
    for keyboard_id in ("en/english", "ja/12key", "ja/50on", "ja/romaji", "ja/jis"):  # 50on through extends
        assert keyboards[keyboard_id]["features"] == {"swipe": {"lexicon": "en/words"}}, keyboard_id
        assert keyboards[keyboard_id]["options"]["swipe"] is False, keyboard_id  # off until turned on
    write(tmp_path / "packs", "mine/qwerty.json", keyboard("mine/qwerty", layout="en/qwerty", options={"swipe": True}))
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["errors"] == ["mine/qwerty: the swipe option needs features.swipe"]
    assert boot["catalog"]["keyboards"]["mine/qwerty"]["options"] == {}  # it still types
    assert packs.clean_keyboard_options({"en/english": {"swipe": False}}) == {"en/english": {"swipe": False}}


def test_a_keyboard_that_cannot_be_extended_is_reported(tmp_path):
    write(tmp_path / "packs", "mine/lost.json", keyboard("mine/lost", extends="mine/nope"))
    write(tmp_path / "packs", "mine/loop-a.json", keyboard("mine/loop-a", extends="mine/loop-b"))
    write(tmp_path / "packs", "mine/loop-b.json", keyboard("mine/loop-b", extends="mine/loop-a"))
    write(tmp_path / "packs", "mine/bare.json", keyboard("mine/bare"))
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert not {"mine/lost", "mine/loop-a", "mine/loop-b", "mine/bare"} & set(boot["catalog"]["keyboards"])
    assert "mine/lost: extends mine/nope, which was not found" in boot["errors"]
    assert any(e.startswith("mine/loop-") and "in a loop" in e for e in boot["errors"])
    assert "mine/bare: needs a layout, or extends a keyboard with one" in boot["errors"]


def test_settings_are_read_and_checked(tmp_path):
    write(tmp_path, "settings.json", {"keyboards": ["xx/nope", "en/english"], "theme": "themes/nope"})
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["settings"] == {
        "keyboards": ["en/english"],
        "theme": "themes/steam",
        "haptics": True,
        "suggestions": True,
        "dictation": False,
        "dictationModels": {},
        "dictationContinuous": False,
        "autoUpdate": True,
    }
    assert "settings.json: unknown keyboards xx/nope" in boot["errors"]
    assert "settings.json: unknown theme themes/nope" in boot["errors"]


def test_the_dictation_models_setting_is_checked(tmp_path):
    choices = {"en": "parakeet-tdt-0.6b-v2", "zh-Hant": "sensevoice-small", "fr": "whisper-small"}
    write(tmp_path, "settings.json", {"dictationModels": choices})
    assert packs.load(BUNDLED, SCHEMA, tmp_path)["settings"]["dictationModels"] == choices
    for bad in ({"english": "x"}, {"en": "../x"}, {"en": 1}, ["en"]):
        write(tmp_path, "settings.json", {"dictationModels": bad})
        assert packs.load(BUNDLED, SCHEMA, tmp_path)["settings"]["dictationModels"] == {}


def test_continuous_dictation_is_a_flag(tmp_path):
    write(tmp_path, "settings.json", {"dictationContinuous": True})
    assert packs.load(BUNDLED, SCHEMA, tmp_path)["settings"]["dictationContinuous"] is True
    write(tmp_path, "settings.json", {"dictationContinuous": "yes"})
    assert packs.load(BUNDLED, SCHEMA, tmp_path)["settings"]["dictationContinuous"] is False


def test_broken_settings_fall_back_to_defaults(tmp_path):
    write(tmp_path, "settings.json", "nope")
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["settings"] == packs.DEFAULT_SETTINGS
    assert boot["errors"] == ["settings.json: not valid JSON (JSONDecodeError); using defaults"]


def test_validator_messages_name_the_field():
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    layout = json.loads((BUNDLED / "en" / "qwerty.json").read_text(encoding="utf-8"))
    cases = {
        json.dumps({"type": "key", "key": "Tab", "wdth": 1}): "/rows/1/0: unknown field wdth",
        json.dumps({"type": "mod", "mod": "hyper"}): "/rows/1/0/mod: must be one of shift, caps, ctrl, alt, super, fn",
        json.dumps({"type": "char"}): "/rows/1/0: missing char",
        json.dumps({"type": "gap", "w": 99}): "/rows/1/0/w: must be at most 16",
    }
    for key, message in cases.items():
        layout["rows"][1][0] = json.loads(key)
        assert packs.validate(layout, schema, schema) == [message]


def test_a_name_is_a_string_or_a_name_per_language(tmp_path):
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    named = lambda name: packs.validate({**theme("mine/dark"), "name": name}, schema, schema)
    for good in ("Dark", {"en": "Dark"}, {"en": "Dark", "ja": "ダーク", "pt-BR": "Escuro", "zh-Hant": "深色"}):
        assert named(good) == [], good
    assert named({}) == ["/name: needs at least 1 entries (it has 0)"]
    assert named("") == ["/name: too short"]
    assert named({"en": ""}) == ["/name/en: too short"]
    assert named({"en": "x" * 81}) == ["/name/en: too long"]
    assert named({"en": 5}) == ["/name/en: must be a string"]
    for key in ("EN", "english", "e", "en_US", "en-", ""):
        assert named({"en": "Dark", key: "Dark"}) == [f"/name: unknown field {key}"], key
    assert named(5) and named(["Dark"]) and named(None)
    # Keyboards, layouts and tables take the same names, and load with them as written.
    name = {"en": "Dark", "ja": "ダーク"}
    write(tmp_path / "packs", "mine/dark.json", {**theme("mine/dark"), "name": name})
    write(tmp_path / "packs", "mine/keys.json", layout("mine/keys", name=name, rows=[["a"]]))
    write(tmp_path / "packs", "mine/board.json", keyboard("mine/board", name=name, layout="mine/keys"))
    write(tmp_path / "packs", "mine/empty.json", {**theme("mine/empty"), "name": {}})
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["errors"] == ["mine/empty.json: /name: needs at least 1 entries (it has 0)"]
    catalog = boot["catalog"]
    assert [
        catalog[k][i]["name"]
        for k, i in (("themes", "mine/dark"), ("layouts", "mine/keys"), ("keyboards", "mine/board"))
    ] == [name] * 3


def test_boot_script_sets_the_catalog_and_logs_pack_errors(tmp_path):
    write(tmp_path / "packs", "themes/broken.json", "{")
    out = io.StringIO()
    script = boot_script(Config(user_dir=tmp_path), Log(out))
    boot = json.loads(script.removeprefix("globalThis.__polykeyBoot = ").rstrip().removesuffix(";"))
    assert "en/qwerty" in boot["catalog"]["layouts"]
    assert "pack: themes/broken.json: not valid JSON" in out.getvalue()


def test_settings_flags_and_saving(tmp_path):
    packs.save_settings(tmp_path / "settings.json", {"haptics": False})
    packs.save_settings(tmp_path / "settings.json", {"theme": "themes/night-owl"})
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["settings"] == {
        "keyboards": ["en/english"],
        "theme": "themes/night-owl",
        "haptics": False,
        "suggestions": True,
        "dictation": False,
        "dictationModels": {},
        "dictationContinuous": False,
        "autoUpdate": True,
    }
    write(tmp_path, "settings.json", {"keyboards": ["en/english"], "custom": 1})
    packs.save_settings(tmp_path / "settings.json", {"suggestions": False})
    assert json.loads((tmp_path / "settings.json").read_text()) == {
        "keyboards": ["en/english"],
        "custom": 1,
        "suggestions": False,
    }


def test_bridge_saves_only_known_settings(tmp_path):
    import asyncio
    from polykey.bridge import Bridge

    bridge = Bridge(Log(io.StringIO()), None, None, tmp_path / "settings.json")
    ask = lambda settings: asyncio.run(
        bridge.handle(json.dumps({"id": 1, "op": "settings.save", "settings": settings}))
    )
    assert ask({"haptics": False}) == {"id": 1, "ok": True}
    assert ask({"haptics": "no"})["error"] == "bad-settings"
    assert ask({"keyboards": []})["error"] == "bad-settings"
    assert ask({"keyboards": ["ja/jis", "ja/jis"]})["error"] == "bad-settings"
    assert ask({"keyboards": ["../etc"]})["error"] == "bad-settings"
    assert ask({"dictationContinuous": 1})["error"] == "bad-settings"
    assert json.loads((tmp_path / "settings.json").read_text()) == {"haptics": False}
    assert ask({"keyboardOptions": {"ja/jis": {"dictationCommit": True}}}) == {"id": 1, "ok": True}
    assert ask({"keyboardOptions": {"ja/12key": {"tapCycle": True}}}) == {"id": 1, "ok": True}
    assert ask({"keyboardOptions": {"ja/12key": {"tapCycle": "yes"}}})["error"] == "bad-settings"
    assert ask({"keyboardOptions": {"ja/12key": {"rm -rf": True}}})["error"] == "bad-settings"
    assert ask({"keyboards": ["ja/jis", "en/english"]}) == {"id": 1, "ok": True}
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["settings"]["keyboardOptions"] == {"ja/12key": {"tapCycle": True}}
    assert boot["settings"]["keyboards"] == ["ja/jis", "en/english"]


def test_the_japanese_12key_pack_loads():
    boot = packs.load(BUNDLED, SCHEMA, None)
    assert boot["errors"] == []
    assert boot["catalog"]["keyboards"]["ja/12key"]["options"] == {
        "tapCycle": False,
        "candidatesLeft": True,
        "flickHints": False,
        "qwertyLatin": True,
        "swipe": False,
    }
    layout = boot["catalog"]["layouts"]["ja/flick"]
    assert layout["rows"][0][1]["flick"] == ["あ", "い", "う", "え", "お"]
    assert "はばぱ" in layout["modify"]


def test_bridge_saves_emoji_state_cleaned(tmp_path):
    import asyncio
    from polykey.bridge import Bridge

    out = io.StringIO()
    bridge = Bridge(Log(out), None, None, tmp_path / "settings.json")
    state = {"recent": ["😀", "🎉"] + ["👍"] * 50, "favorites": [], "tone": "nope"}
    reply = asyncio.run(bridge.handle(json.dumps({"id": 1, "op": "emoji.save", "state": state})))
    assert reply == {"id": 1, "ok": True}
    saved = json.loads((tmp_path / "emoji.json").read_text(encoding="utf-8"))
    assert saved["tone"] == ""
    assert saved["recent"] == {"emoji/emoji": ["😀", "🎉"] + ["👍"] * 38} and saved["set"] == ""
    assert "😀" not in out.getvalue()


def test_alone_rows_hide_the_globe_and_apply_each_keys_patch(tmp_path):
    a = {"type": "char", "char": "a"}
    globe = {"type": "action", "action": "next-keyboard"}
    tall = {"type": "action", "action": "eisu", "rows": 2, "alone": {"rows": 3}}
    write(
        tmp_path / "packs",
        "mine/one.json",
        layout("mine/one", rows=[[tall, a], [a], [globe, {"type": "char", "char": " ", "alone": {"w": 1}}]]),
    )
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["errors"] == []
    mine = boot["catalog"]["layouts"]["mine/one"]
    # Shown normally: the patches are gone, 🌐 is there, 英数 two rows high.
    assert mine["rows"][2] == [globe, {"type": "char", "char": " "}]
    assert mine["rows"][0][0] == {"type": "action", "action": "eisu", "tall": "top", "span": 2}
    # With one keyboard: no 🌐, space wider, 英数 three rows high.
    alone = mine["aloneRows"]
    assert [k["tall"] for k in (alone[0][0], alone[1][0], alone[2][0])] == ["top", "middle", "bottom"]
    assert alone[2] == [
        {"type": "action", "action": "eisu", "w": 1, "tall": "bottom"},
        {"type": "char", "char": " ", "w": 1},
    ]


def test_alone_rows_that_do_not_fit_leave_the_globe_as_a_gap(tmp_path):
    a = {"type": "char", "char": "a"}
    write(
        tmp_path / "packs",
        "mine/two.json",
        layout("mine/two", rows=[[a, a], [a, {"type": "action", "action": "next-keyboard"}]]),
    )
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["errors"] == ["mine/two: row 1 is 1 wide, the layout is 2 (with one keyboard; 🌐 left as a gap)"]
    assert boot["catalog"]["layouts"]["mine/two"]["aloneRows"][1] == [a, {"type": "gap", "w": 1}]


def test_a_layout_without_a_globe_has_no_alone_rows(tmp_path):
    a = {"type": "char", "char": "a"}
    write(tmp_path / "packs", "mine/none.json", layout("mine/none", rows=[[a]]))
    assert "aloneRows" not in packs.load(BUNDLED, SCHEMA, tmp_path)["catalog"]["layouts"]["mine/none"]


def language(code: str, **fields) -> dict:
    return {"schemaVersion": 1, "kind": "language", "id": code, "name": code, **fields}


def test_a_language_is_named_by_its_code_and_lives_in_its_folder(tmp_path):
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["errors"] == []
    ja = boot["catalog"]["languages"]["ja"]
    assert (ja["letters"], ja["labels"]["convert"], ja["idleHint"]) == (
        "あいう",
        "変換",
        "入力すると、ここに変換候補が出ます",
    )
    write(tmp_path / "packs", "de/german.json", language("de", letters="ABC", labels={"confirm": "OK"}, dictation="de"))
    write(tmp_path / "packs", "mine/french.json", language("fr"))
    write(tmp_path / "packs", "es/spanish.json", language("es", labels={"Convert!": "x"}))
    write(tmp_path / "packs", "pt/portuguese.json", language("pt", letters="abcdefghi"))
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["catalog"]["languages"]["de"]["labels"] == {"confirm": "OK"}
    assert boot["errors"] == [
        "es/spanish.json: /labels: unknown field Convert!",
        "mine/french.json: /id: must be mine (the folder name)",
        "pt/portuguese.json: /letters: too long",
    ]
    assert {"de", "ja"} <= set(boot["catalog"]["languages"]) and not {"es", "fr", "pt"} & set(
        boot["catalog"]["languages"]
    )


def test_a_language_of_yours_replaces_the_bundled_one(tmp_path):
    write(tmp_path / "packs", "ja/mine.json", language("ja", letters="かな", labels={"convert": "Convert"}))
    ja = packs.load(BUNDLED, SCHEMA, tmp_path)["catalog"]["languages"]["ja"]
    assert (ja["letters"], ja["labels"], "idleHint" in ja) == ("かな", {"convert": "Convert"}, False)


def test_a_mode_takes_its_letters_from_the_language_unless_it_names_them(tmp_path):
    keyboards = packs.load(BUNDLED, SCHEMA, tmp_path)["catalog"]["keyboards"]
    assert keyboards["ja/12key"]["modes"] == [{"id": "kana"}, {"id": "latin", "letters": "ABC", "latin": True}]
    assert "strings" not in keyboards["ja/jis"]  # the idle hint is the language's


def test_the_korean_packs_load():
    boot = packs.load(BUNDLED, SCHEMA, None)
    assert boot["errors"] == []
    catalog = boot["catalog"]
    korean = catalog["keyboards"]["ko/korean"]
    assert (korean["composer"], korean["table"], korean["pages"]) == ("hangul", "ko/hangul", {"latin": "ko/qwerty"})
    assert len(catalog["tables"]["ko/hangul"]["hangul"]["compoundFinals"]) == 11
    assert (catalog["languages"]["ko"]["letters"], catalog["languages"]["ko"]["cjk"]) == ("한글", True)
    hangul, latin = catalog["layouts"]["ko/dubeolsik"], catalog["layouts"]["ko/qwerty"]
    assert hangul["rows"][1][1] == {"type": "char", "char": "ㅂ", "shift": "ㅃ"} and latin["rows"][1][1] == "q"
    assert hangul["rows"][4] == latin["rows"][4]  # one bottom row, with 한/영
    assert {"type": "action", "action": "mode", "legends": {"c": {"parts": ["한", "영"]}}, "w": 1.5} in hangul["rows"][
        4
    ]


def hangul_table(item_id: str, **fields) -> dict:
    base = packs.read_json((BUNDLED / "ko" / "hangul.json").read_text(encoding="utf-8"))["hangul"]
    return {"schemaVersion": 1, "kind": "table", "id": item_id, "name": item_id, "hangul": {**base, **fields}}


def test_a_hangul_table_is_checked(tmp_path):
    # The jamo and their order are Unicode's, not a table's: a table only says which pairs make one.
    write(
        tmp_path / "packs",
        "mine/order.json",
        hangul_table("mine/order", initials="ㄲㄱㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"),
    )
    write(tmp_path / "packs", "mine/vowels.json", hangul_table("mine/vowels", compoundMedials=["ㅗㄱㅘ"]))
    write(tmp_path / "packs", "mine/finals.json", hangul_table("mine/finals", compoundFinals=["ㄱㅅㅘ"]))
    write(tmp_path / "packs", "mine/tense.json", hangul_table("mine/tense", compoundFinals=["ㄷㄷㄸ"]))  # ㄸ ends none
    write(tmp_path / "packs", "mine/both.json", {**hangul_table("mine/both"), "cycles": ["はばぱ"]})
    write(tmp_path / "packs", "mine/fine.json", hangul_table("mine/fine", compoundMedials=[]))
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    finals = "does not match ^[ㄱ-ㄷㄹ-ㅂㅄ-ㅈㅊ-ㅎ]{3}$"
    assert sorted(boot["errors"]) == [
        "mine/both.json: /: needs entries, cycles or hangul (one of them)",
        f"mine/finals.json: /hangul/compoundFinals/0: {finals}",
        "mine/order.json: /hangul: unknown field initials",
        f"mine/tense.json: /hangul/compoundFinals/0: {finals}",
        "mine/vowels.json: /hangul/compoundMedials/0: does not match ^[ㅏ-ㅣ]{3}$",
    ]
    assert "mine/fine" in boot["catalog"]["tables"]


def test_a_hangul_keyboard_needs_its_hangul_table(tmp_path):
    write(tmp_path / "packs", "mine/ko.json", keyboard("mine/ko", extends="ko/korean", table="ja/romaji-table"))
    write(tmp_path / "packs", "mine/ko2.json", keyboard("mine/ko2", extends="ko/korean", table="mine/nope"))
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["errors"] == [
        "mine/ko: hangul table ja/romaji-table not found",
        "mine/ko2: hangul table mine/nope not found",
    ]
    assert "ko/korean" in boot["catalog"]["keyboards"] and "mine/ko" not in boot["catalog"]["keyboards"]
