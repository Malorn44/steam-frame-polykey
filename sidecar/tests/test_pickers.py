"""Picker sets (kind "picker"): the bundled emoji and kaomoji, a user's own, and what is refused."""

from __future__ import annotations

import json
from pathlib import Path

from polykey import packs

REPO = Path(__file__).resolve().parents[2]
SCHEMA = REPO / "packs" / "pack.schema.json"
BUNDLED = REPO / "packs"
EMOJI_GROUPS = ["smileys", "people", "animals", "food", "travel", "activities", "objects", "symbols", "flags"]


def write(directory: Path, name: str, data) -> None:
    path = directory / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")


def category(category_id: str, items=("a", "b"), **more) -> dict:
    return {"id": category_id, "name": category_id.title(), "items": list(items), **more}


def picker(set_id: str, *categories: dict, **more) -> dict:
    return {
        "schemaVersion": 1,
        "kind": "picker",
        "id": set_id,
        "name": "Mine",
        "icon": "symbols",
        "categories": list(categories) or [category("one")],
        **more,
    }


def load(tmp_path: Path) -> dict:
    return packs.load(BUNDLED, SCHEMA, tmp_path)


def sets(boot: dict) -> dict:
    return {s["id"]: s for s in boot["pickers"]}


def ids(picker_set: dict) -> list[str]:
    return [c["id"] for c in picker_set["categories"]]


def test_the_bundled_sets_are_emoji_then_kaomoji(tmp_path):
    boot = load(tmp_path)
    assert boot["errors"] == []
    emoji, kaomoji = boot["pickers"]
    assert {k: v for k, v in emoji.items() if k != "categories"} == {
        "id": "emoji/emoji",
        "name": {"en": "Emoji", "ja": "絵文字"},
        "icon": "emoji",
        "cellWidth": 1,
        "tones": True,
        "steam": True,
        "favorites": True,
    }
    assert {k: v for k, v in kaomoji.items() if k != "categories"} == {
        "id": "emoji/kaomoji",
        "name": {"en": "Kaomoji", "ja": "顔文字"},
        "icon": "emoticons",
        "cellWidth": 2.5,
    }
    # Emoji: Unicode's groups from emoji.data, each with its tab icon; skin tones as written there.
    data = json.loads((BUNDLED / "emoji" / "emoji.data").read_text(encoding="utf-8"))["groups"]
    assert [(c["id"], c["name"], c["icon"]) for c in emoji["categories"]] == [
        (g["id"], g["name"], g["id"]) for g in data
    ]
    assert ids(emoji) == EMOJI_GROUPS
    assert [c["items"] for c in emoji["categories"]] == [g["items"] for g in data]
    assert emoji["categories"][0]["items"][0] == "😀"
    assert any(isinstance(i, list) and len(i) == 6 for i in emoji["categories"][1]["items"])
    # Kaomoji: named categories without icons, in the pack's order.
    assert len(kaomoji["categories"]) > 1
    assert all(set(c) == {"id", "name", "items"} and list(c["name"]) == ["en", "ja"] for c in kaomoji["categories"])
    assert ids(kaomoji)[0] == "smiling"


def test_the_page_gets_texts_and_the_sidecar_keeps_readings_and_tags(tmp_path):
    kaomoji = load(tmp_path)["pickers"][1]
    assert all(isinstance(item, str) for c in kaomoji["categories"] for item in c["items"])
    written = json.loads((BUNDLED / "emoji" / "kaomoji.json").read_text(encoding="utf-8"))["categories"]
    assert [c["items"] for c in kaomoji["categories"]] == [[item["text"] for item in c["items"]] for c in written]
    kept = packs.loaded_pickers()[1]
    assert kept["id"] == "emoji/kaomoji" and [c["items"] for c in kept["categories"]] == [c["items"] for c in written]
    assert any(item.get("reading") and item.get("tags") for c in kept["categories"] for item in c["items"])


def test_a_users_pack_adds_a_set_after_the_bundled_ones(tmp_path):
    shy = {"text": "(o_o)", "reading": ["じー"], "tags": ["見る"]}
    mine = picker(
        "mine/symbols",
        category("arrows", ["→", "←"], icon="right"),
        category("faces", [shy, {"text": ":)"}], name={"en": "Faces", "ja": "顔"}),
        cellWidth=2,
    )
    write(tmp_path / "packs", "mine/symbols.json", mine)
    boot = load(tmp_path)
    assert boot["errors"] == []
    assert [s["id"] for s in boot["pickers"]] == ["emoji/emoji", "emoji/kaomoji", "mine/symbols"]
    assert boot["pickers"][2] == {
        "id": "mine/symbols",
        "name": "Mine",
        "icon": "symbols",
        "cellWidth": 2,
        "categories": [
            {"id": "arrows", "name": "Arrows", "icon": "right", "items": ["→", "←"]},
            {"id": "faces", "name": {"en": "Faces", "ja": "顔"}, "items": ["(o_o)", ":)"]},
        ],
    }
    assert packs.loaded_pickers()[2]["categories"][1]["items"] == [shy, {"text": ":)"}]


def test_a_users_category_replaces_the_bundled_one_with_its_id_and_others_are_added(tmp_path):
    bundled = sets(load(tmp_path / "none"))["emoji/kaomoji"]
    mine = picker("emoji/kaomoji", category("love", ["<3"]), category("mine", ["o/"]), name="Faces", icon="smileys")
    write(tmp_path / "packs", "emoji/kaomoji.json", mine)
    boot = load(tmp_path)
    assert boot["errors"] == []
    assert [s["id"] for s in boot["pickers"]] == ["emoji/emoji", "emoji/kaomoji"]  # still second
    kaomoji = sets(boot)["emoji/kaomoji"]
    assert ids(kaomoji) == [*ids(bundled), "mine"]  # love keeps its place
    by_id = {c["id"]: c for c in kaomoji["categories"]}
    assert by_id["love"] == {"id": "love", "name": "Love", "items": ["<3"]}
    assert by_id["mine"]["items"] == ["o/"]
    assert by_id["smiling"] == bundled["categories"][0]
    # The set's own fields are the user's; what the user's pack leaves out stays as bundled.
    assert (kaomoji["name"], kaomoji["icon"], kaomoji["cellWidth"]) == ("Faces", "smileys", 2.5)


def test_a_users_set_can_turn_a_bundled_sets_flags_off(tmp_path):
    mine = picker("emoji/emoji", category("flags", ["🏁"], icon="flags"), favorites=False)
    write(tmp_path / "packs", "emoji/emoji.json", mine)
    emoji = sets(load(tmp_path))["emoji/emoji"]
    assert (emoji["favorites"], emoji["tones"], emoji["steam"]) == (False, True, True)
    assert ids(emoji) == EMOJI_GROUPS and emoji["categories"][-1]["items"] == ["🏁"]


def test_items_come_from_a_data_file(tmp_path):
    wave = ["👋", "👋🏻", "👋🏼", "👋🏽", "👋🏾", "👋🏿"]
    groups = [
        {"id": "hands", "name": "ignored", "items": [wave, "👍"]},
        {"id": "other", "items": [{"text": "(^_^)", "reading": ["にこ"]}]},
    ]
    write(tmp_path / "packs", "mine/big.data", {"notice": "mine", "groups": groups})
    file = {"file": "mine/big.data"}
    mine = picker(
        "mine/big",
        category("hands", items=()) | {"items": file},  # the group with the category's id
        category("faces", items=()) | {"items": {**file, "group": "other"}},
        category("inline", ["x"]),
        tones=True,
    )
    write(tmp_path / "packs", "mine/big.json", mine)
    boot = load(tmp_path)
    assert boot["errors"] == []
    assert [c["items"] for c in sets(boot)["mine/big"]["categories"]] == [[wave, "👍"], ["(^_^)"], ["x"]]
    # Skin tones reach the page only from a set that offers them.
    write(tmp_path / "packs", "mine/big.json", {**mine, "tones": False})
    assert sets(load(tmp_path))["mine/big"]["categories"][0]["items"] == ["👋", "👍"]


def test_a_users_copy_of_emoji_data_is_read_instead(tmp_path):
    groups = [{"id": "smileys", "name": "Smileys & Emotion", "items": ["🙂"]}]
    write(tmp_path / "packs", "emoji/emoji.data", {"groups": groups})
    boot = load(tmp_path)
    assert boot["errors"] == []
    emoji = sets(boot)["emoji/emoji"]
    assert ids(emoji) == EMOJI_GROUPS  # a group the copy leaves out is the bundled one
    assert emoji["categories"][0]["items"] == ["🙂"]
    assert len(emoji["categories"][1]["items"]) > 100


def test_a_bad_copy_of_a_data_file_is_reported_once_and_the_bundled_one_read(tmp_path):
    bundled = load(tmp_path / "none")["pickers"]
    bad = {
        "{not json": "emoji/emoji.data: not valid JSON (JSONDecodeError)",
        "[]": "emoji/emoji.data: no groups",
        json.dumps({"groups": [{"items": ["🙂"]}]}): "emoji/emoji.data: no groups",
        "[" + " " * packs.MAX_FILE_BYTES + "]": "emoji/emoji.data: larger than 256 KiB",
        json.dumps({"groups": [{"id": "smileys", "items": []}]}): "emoji/emoji.data: /smileys: needs at least 1 items",
        json.dumps({"groups": [{"id": "smileys"}]}): "emoji/emoji.data: /smileys: must be an array",
        json.dumps({"groups": [{"id": "smileys", "items": ["🙂", "two\nlines"]}]}): None,
        json.dumps({"groups": [{"id": "smileys", "items": [["👋", "👋🏻"]]}]}): None,
    }
    for data, message in bad.items():
        write(tmp_path / "packs", "emoji/emoji.data", data)
        boot = load(tmp_path)
        assert len(boot["errors"]) == 1 and boot["errors"][0].startswith("emoji/emoji.data: "), data[:60]
        assert message is None or boot["errors"] == [message]
        assert boot["pickers"] == bundled


def test_a_category_whose_data_is_missing_is_left_out(tmp_path):
    file = {"file": "mine/none.data"}
    write(tmp_path / "packs", "mine/set.json", picker("mine/set", category("a"), category("b") | {"items": file}))
    boot = load(tmp_path)
    assert boot["errors"] == ["mine/set: category b: no group b in mine/none.data"]
    assert ids(sets(boot)["mine/set"]) == ["a"]
    # With nothing left to show, there is no set.
    write(tmp_path / "packs", "mine/set.json", picker("mine/set", category("b") | {"items": file}))
    boot = load(tmp_path)
    assert boot["errors"] == ["mine/set: category b: no group b in mine/none.data", "mine/set: no categories"]
    assert "mine/set" not in sets(boot)


def test_a_bad_picker_pack_is_reported_and_skipped(tmp_path):
    items = lambda *found: picker("mine/set", category("one", found))
    word = lambda **more: items({"text": "ok", **more})
    bad = {
        "/icon: must be one of": picker("mine/set", icon="rocket"),
        "/: missing icon": {k: v for k, v in picker("mine/set").items() if k != "icon"},
        "/: missing name": {k: v for k, v in picker("mine/set").items() if k != "name"},
        "/: missing categories": {k: v for k, v in picker("mine/set").items() if k != "categories"},
        "/: unknown field faces": picker("mine/set", faces=[]),
        "/cellWidth: must be at least 1": picker("mine/set", cellWidth=0.5),
        "/cellWidth: must be at most 4": picker("mine/set", cellWidth=9),
        "/cellWidth: must be a number": picker("mine/set", cellWidth="wide"),
        "/tones: must be a boolean": picker("mine/set", tones="yes"),
        "/categories: needs at least 1 items": {**picker("mine/set"), "categories": []},
        "/categories: at most 64 items": picker("mine/set", *(category(f"c{i}") for i in range(65))),
        "/categories/0/id: does not match": picker("mine/set", category("Mine!")),
        "/categories/0: missing name": picker("mine/set", {"id": "one", "items": ["a"]}),
        "/categories/0/name": picker("mine/set", category("one", name={"EN": "One"})),
        "/categories/0/icon: must be one of": picker("mine/set", category("one", icon=None)),
        "/categories/0: unknown field faces": picker("mine/set", category("one", faces=["a"])),
        "/categories/0/items: needs at least 1 items": items(),
        "/categories/0/items: at most 2000 items": items(*(str(n) for n in range(2001))),
        "/categories/0/items/1": items("ok", 5),
        "/categories/0/items/0: too long": items("x" * 65),
        "/categories/0/items/0: does not match": items("two\nlines"),
        "/categories/0/items/0: too short": items(""),
        "/categories/0/items/0: missing text": items({"reading": ["にこ"]}),
        "/categories/0/items/0/text: must be a string": items({"text": ["ok"]}),
        "/categories/0/items/0: unknown field faces": word(faces=1),
        "/categories/0/items/0/reading: must be an array": word(reading="にこにこ"),
        "/categories/0/items/0/reading/1: must be a string": word(reading=["にこ", 5]),
        "/categories/0/items/0/reading/0: too short": word(reading=[""]),
        "/categories/0/items/0/reading/0: too long": word(reading=["に" * 33]),
        "/categories/0/items/0/reading/0: does not match": word(reading=["に\nこ"]),
        "/categories/0/items/0/reading: at most 16 items": word(reading=["にこ"] * 17),
        "/categories/0/items/0/tags: must be an array": word(tags={"笑顔": True}),
        "/categories/0/items/0/tags/0: too long": word(tags=["笑" * 33]),
        "/categories/0/items/0: needs at least 6 items": items(["👋", "👋🏻"]),
        "/categories/0/items/file: does not match": items()
        | {"categories": [category("one") | {"items": {"file": "../x.data"}}]},
        "/categories/0/items: unknown field path": items()
        | {"categories": [category("one") | {"items": {"file": "a/b.data", "path": 1}}]},
    }
    for message, data in bad.items():
        write(tmp_path / "packs", "mine/set.json", data)
        boot = load(tmp_path)
        assert len(boot["errors"]) == 1 and boot["errors"][0].startswith(f"mine/set.json: {message}"), (
            message,
            boot["errors"],
        )
        assert [s["id"] for s in boot["pickers"]] == ["emoji/emoji", "emoji/kaomoji"]
    for data in (word(reading=["に" * 32] * 16, tags=["笑" * 32] * 16), word(reading=[]), items("x" * 64)):
        write(tmp_path / "packs", "mine/set.json", data)
        assert load(tmp_path)["errors"] == [], data


def test_what_the_schema_cannot_say_is_checked_too(tmp_path):
    bad = {
        "mine/set: category one is defined twice": picker("mine/set", category("one"), category("one")),
        "mine/set: category recent: that id is the picker's own": picker("mine/set", category("recent")),
        "mine/set: category favorites: that id is the picker's own": picker("mine/set", category("favorites")),
        "mine/set: category steam-sticker: that id is the picker's own": picker("mine/set", category("steam-sticker")),
        "mine/set: more than 4000 items": picker(
            "mine/set", *(category(f"c{i}", [str(n) for n in range(1001)]) for i in range(4))
        ),
    }
    for message, data in bad.items():
        write(tmp_path / "packs", "mine/set.json", data)
        boot = load(tmp_path)
        assert boot["errors"] == [message]
        assert "mine/set" not in sets(boot)


def test_a_bad_override_is_reported_and_the_bundled_set_kept(tmp_path):
    bundled = load(tmp_path / "none")["pickers"]
    many = [category(f"c{i}") for i in range(60)]
    bad = {
        "emoji/kaomoji.json: /icon: must be one of": picker("emoji/kaomoji", icon="rocket"),
        "emoji/kaomoji: category love is defined twice": picker("emoji/kaomoji", category("love"), category("love")),
        "emoji/kaomoji: more than 64 categories": picker("emoji/kaomoji", *many),
    }
    for message, data in bad.items():
        write(tmp_path / "packs", "emoji/kaomoji.json", data)
        boot = load(tmp_path)
        assert len(boot["errors"]) == 1 and boot["errors"][0].startswith(message), boot["errors"]
        assert boot["pickers"] == bundled


def test_at_most_16_sets(tmp_path):
    for i in range(16):
        write(tmp_path / "packs", f"mine/s{i:02}.json", picker(f"mine/s{i:02}"))
    boot = load(tmp_path)
    assert boot["errors"] == ["more than 16 picker sets: mine/s14, mine/s15 left out"]
    assert len(boot["pickers"]) == 16 and boot["pickers"][-1]["id"] == "mine/s13"


def test_without_picker_packs_there_are_no_sets(tmp_path):
    boot = packs.load(tmp_path / "bundled", SCHEMA, tmp_path)
    assert boot["pickers"] == [] and packs.loaded_pickers() == []


# --- the saved state -----------------------------------------------------------------------------

NO_STATE = {"recent": {}, "favorites": [], "tone": "", "set": ""}


def test_state_is_recent_per_set_favorites_the_tone_and_the_set_last_shown(tmp_path):
    assert load(tmp_path)["emojiState"] == NO_STATE
    state = {
        "recent": {"emoji/emoji": ["😀", 5, "x" * 97, "steam:sticker:Hi"], "mine/symbols": ["→"], "emoji/kaomoji": []},
        "favorites": ["⭐", ""],
        "tone": "dark",
        "set": "mine/symbols",
        "other": 1,
    }
    write(tmp_path, "emoji.json", state)
    assert load(tmp_path)["emojiState"] == {
        "recent": {"emoji/emoji": ["😀", "steam:sticker:Hi"], "mine/symbols": ["→"]},
        "favorites": ["⭐"],
        "tone": "dark",
        "set": "mine/symbols",
    }


def test_state_that_is_not_the_expected_shape_is_dropped():
    assert packs.clean_emoji_state(None) == NO_STATE
    assert packs.clean_emoji_state({"recent": "😀", "favorites": {"a": 1}, "tone": "nope", "set": 5}) == NO_STATE
    for set_id in ("Emoji", "emoji", "../x", "a/b/c", "a/" + "b" * 90, ""):
        assert packs.clean_emoji_state({"recent": {set_id: ["a"]}, "set": set_id}) == NO_STATE, set_id
    long = packs.clean_emoji_state({"recent": {"mine/a": ["^^"] * 50, "mine/b": "^^"}})
    assert list(long["recent"]) == ["mine/a"] and len(long["recent"]["mine/a"]) == packs.MAX_EMOJI_LIST
    many = packs.clean_emoji_state({"recent": {f"mine/s{i}": ["a"] for i in range(40)}})
    assert len(many["recent"]) == packs.MAX_PICKER_SETS


def test_a_state_from_before_sets_were_packs_still_loads(tmp_path):
    # As main saves it today: one Recent, no kaomoji.
    old = {"recent": ["😀", "steam:emoticon:steamhappy"], "favorites": ["⭐"], "tone": "medium"}
    assert packs.clean_emoji_state(old) == {
        "recent": {"emoji/emoji": ["😀", "steam:emoticon:steamhappy"]},
        "favorites": ["⭐"],
        "tone": "medium",
        "set": "",
    }
    # With kaomoji: their own Recent, and the mode last shown.
    old = {**old, "kaomojiRecent": ["(^_^)", 5, ""], "mode": "kaomoji"}
    write(tmp_path, "emoji.json", old)
    assert load(tmp_path)["emojiState"] == {
        "recent": {"emoji/emoji": ["😀", "steam:emoticon:steamhappy"], "emoji/kaomoji": ["(^_^)"]},
        "favorites": ["⭐"],
        "tone": "medium",
        "set": "emoji/kaomoji",
    }
    assert packs.clean_emoji_state({**old, "mode": "emoji"})["set"] == "emoji/emoji"
    assert packs.clean_emoji_state({"recent": [], "kaomojiRecent": [], "mode": "stickers"}) == NO_STATE
    # What was migrated reads the same again.
    migrated = packs.clean_emoji_state(old)
    assert packs.clean_emoji_state(migrated) == migrated
