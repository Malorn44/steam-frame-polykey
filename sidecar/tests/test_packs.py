from __future__ import annotations

import io
import json
from pathlib import Path

from polykey import packs
from polykey.injector import Config, Log, boot_script

REPO = Path(__file__).resolve().parents[2]
SCHEMA = REPO / "schema" / "pack.schema.json"
BUNDLED = REPO / "packs"


def write(directory: Path, name: str, data) -> None:
    path = directory / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")


def theme(item_id: str, surface: str = "#000000") -> dict:
    return {"schemaVersion": 1, "kind": "theme", "id": item_id, "name": "T",
            "colors": {"surface": surface, "key": "#111111", "keyText": "#ffffff", "modifier": "#222222", "accent": "#ff0000"}}


def test_bundled_packs_are_valid(tmp_path):
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["errors"] == []
    assert set(boot["catalog"]["layouts"]) == {"en/qwerty", "ja/flick", "ja/flick-abc", "ja/flick-qwerty", "ja/flick-symbols", "ja/flick-symbols2", "ja/gojuon", "ja/kana-jis", "ja/qwerty-romaji"}
    assert set(boot["catalog"]["tables"]) == {"ja/romaji-table"}
    assert boot["settings"] == {"keyboards": ["en/english", "ja/12key", "ja/50on", "ja/romaji", "ja/jis"], "theme": "themes/steam", "haptics": True, "suggestions": True}
    assert "$schema" not in boot["catalog"]["layouts"]["en/qwerty"]


def test_every_bundled_layout_row_is_15_units(tmp_path):
    layout = packs.load(BUNDLED, SCHEMA, tmp_path)["catalog"]["layouts"]["en/qwerty"]
    widths = [sum(k.get("w", 1) if isinstance(k, dict) else 1 for k in row) for row in layout["rows"]]
    assert widths == [15] * len(widths)


def test_a_user_item_replaces_the_bundled_one(tmp_path):
    write(tmp_path / "packs", "themes/night-owl.json", theme("themes/night-owl", "#123456"))
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["catalog"]["themes"]["themes/night-owl"]["colors"]["surface"] == "#123456"


def test_a_bad_user_file_is_reported_and_the_bundled_item_kept(tmp_path):
    write(tmp_path / "packs", "themes/night-owl.json", theme("themes/night-owl", "blue"))
    write(tmp_path / "packs", "themes/broken.json", "{ not json")
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["catalog"]["themes"]["themes/night-owl"]["colors"]["surface"] == "#011627"
    assert "themes/night-owl.json: /colors/surface: does not match ^#[0-9a-fA-F]{6}$" in boot["errors"]
    assert "themes/broken.json: not valid JSON (JSONDecodeError)" in boot["errors"]


def test_ids_must_live_in_their_namespace_folder(tmp_path):
    write(tmp_path / "packs", "mine/theme.json", theme("other/theme"))
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["errors"] == ["mine/theme.json: /id: must start with mine/ (the folder name)"]


def test_a_keyboard_needs_its_layout(tmp_path):
    write(tmp_path / "packs", "fr/azerty.json", {"schemaVersion": 1, "kind": "keyboard", "id": "fr/azerty",
                                                 "name": "Français", "layout": "fr/azerty"})
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert "fr/azerty" not in boot["catalog"]["keyboards"]
    assert boot["errors"] == ["fr/azerty: layout fr/azerty not found"]


def test_settings_are_read_and_checked(tmp_path):
    write(tmp_path, "settings.json", {"keyboards": ["xx/nope", "en/english"], "theme": "themes/nope"})
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    assert boot["settings"] == {"keyboards": ["en/english"], "theme": "themes/steam", "haptics": True, "suggestions": True}
    assert "settings.json: unknown keyboards xx/nope" in boot["errors"]
    assert "settings.json: unknown theme themes/nope" in boot["errors"]


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
    assert boot["settings"] == {"keyboards": ["en/english", "ja/12key", "ja/50on", "ja/romaji", "ja/jis"], "theme": "themes/night-owl", "haptics": False, "suggestions": True}
    write(tmp_path, "settings.json", {"keyboards": ["en/english"], "custom": 1})
    packs.save_settings(tmp_path / "settings.json", {"suggestions": False})
    assert json.loads((tmp_path / "settings.json").read_text()) == {"keyboards": ["en/english"], "custom": 1, "suggestions": False}


def test_bridge_saves_only_known_settings(tmp_path):
    import asyncio
    from polykey.bridge import Bridge
    bridge = Bridge(Log(io.StringIO()), None, None, tmp_path / "settings.json")
    ask = lambda settings: asyncio.run(bridge.handle(json.dumps({"id": 1, "op": "settings.save", "settings": settings})))
    assert ask({"haptics": False}) == {"id": 1, "ok": True}
    assert ask({"haptics": "no"})["error"] == "bad-settings"
    assert ask({"keyboards": []})["error"] == "bad-settings"
    assert ask({"keyboards": ["ja/jis", "ja/jis"]})["error"] == "bad-settings"
    assert ask({"keyboards": ["../etc"]})["error"] == "bad-settings"
    assert json.loads((tmp_path / "settings.json").read_text()) == {"haptics": False}
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
    assert boot["catalog"]["keyboards"]["ja/12key"]["options"] == {"tapCycle": False, "candidatesLeft": True, "flickHints": False, "qwertyLatin": True}
    layout = boot["catalog"]["layouts"]["ja/flick"]
    assert layout["rows"][0][1]["flick"] == ["あ", "い", "う", "え", "お"]
    assert "はばぱ" in layout["modify"]


def test_emoji_data_and_state(tmp_path):
    boot = packs.load(BUNDLED, SCHEMA, tmp_path)
    groups = boot["emoji"]["groups"]
    assert [g["id"] for g in groups][:2] == ["smileys", "people"]
    assert groups[0]["items"][0] == "😀"
    assert any(isinstance(i, list) and len(i) == 6 for i in groups[1]["items"])  # skin tones
    assert boot["emojiState"] == {"recent": [], "favorites": [], "tone": ""}
    write(tmp_path, "emoji.json", {"recent": ["😀", 5, "x" * 99], "favorites": ["⭐"], "tone": "dark", "other": 1})
    assert packs.load(BUNDLED, SCHEMA, tmp_path)["emojiState"] == {"recent": ["😀"], "favorites": ["⭐"], "tone": "dark"}


def test_bridge_saves_emoji_state_cleaned(tmp_path):
    import asyncio
    from polykey.bridge import Bridge
    out = io.StringIO()
    bridge = Bridge(Log(out), None, None, tmp_path / "settings.json")
    state = {"recent": ["😀", "🎉"] + ["👍"] * 50, "favorites": [], "tone": "nope"}
    reply = asyncio.run(bridge.handle(json.dumps({"id": 1, "op": "emoji.save", "state": state})))
    assert reply == {"id": 1, "ok": True}
    saved = json.loads((tmp_path / "emoji.json").read_text(encoding="utf-8"))
    assert len(saved["recent"]) == 40 and saved["tone"] == ""
    assert "😀" not in out.getvalue()
