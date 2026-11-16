"""The hanja converter on small dictionaries in libhangul's format: lookups, the longest word ending the
reading, resizing it, meanings as notes, learning picks, and files that are missing or broken."""

import asyncio
import io
import json
import random

import pytest

from polykey.bridge import Bridge
from polykey.converters import Converters
from polykey.converters import hanja as hanja_module
from polykey.converters.engine import Converter
from polykey.converters.hanja import Hanja, HanjaUnavailable
from polykey.injector import Log

HEADER = "# Copyright (c) 2005,2006 Choe Hwanjin\n# All rights reserved.\n# \n\n"
LINES = [
    "교:校:학교 교",
    "국:國:나라 국",
    "국:局:",
    "늘:",  # a word with no Hanja: skipped
    "대한민국:大韓民國:대한민국",  # a meaning that only repeats the word is no note
    "서:西:서녘 서",
    "오늘:",
    "학교:學校:",
    "학교:學敎:",
    "한:韓:나라 이름 한, 한나라 한",
    "한:漢:한수 한",
    "한:寒:찰 한",
    "한국:寒國:",
    "한국:寒菊:",
    "한국:韓國:대한민국",
    "한국어:韓國語:",
]


def dictionary(tmp_path, lines=LINES, header=HEADER, end="\n"):
    path = tmp_path / "hanja.txt"
    path.write_bytes((header + "\n".join(lines) + end).encode("utf-8"))
    return path


def make(tmp_path, **kwargs):
    return Hanja(dictionary(tmp_path, **kwargs), tmp_path / "share" / "hanja-learned.json")


def candidates(engine, reading, **kwargs):
    return [(s["reading"], s["candidates"]) for s in engine.convert(reading, **kwargs)]


def test_lookups_find_each_word_and_only_it(tmp_path):
    engine = make(tmp_path)
    assert engine.convert("국") == [{"reading": "국", "candidates": ["國", "局"], "notes": ["나라 국", ""]}]
    assert candidates(engine, "한") == [("한", ["韓", "漢", "寒"])]  # not 한국's
    assert engine.convert("한국어")[0]["candidates"] == ["韓國語"]  # no notes: none of its Hanja has one
    assert "notes" not in engine.convert("한국어")[0]
    assert engine.convert("대한민국") == [{"reading": "대한민국", "candidates": ["大韓民國"]}]
    assert engine.convert("가") == engine.convert("늘") == engine.convert("힣") == []
    assert engine.predict("한국") == []


def test_the_longest_word_anywhere_in_the_reading_is_converted_and_what_goes_around_it_is_not(tmp_path):
    engine = make(tmp_path)
    assert engine.convert("학교에서") == [
        {"reading": "학교", "candidates": ["學校", "學敎"]},  # not 서, nor 교 (inside 학교)
        {"reading": "에서", "candidates": []},
    ]
    assert engine.convert("오늘한국") == [
        {"reading": "오늘", "candidates": []},
        {"reading": "한국", "candidates": ["寒國", "寒菊", "韓國"], "notes": ["", "", "대한민국"]},
    ]
    assert candidates(engine, "한국어") == [("한국어", ["韓國語"])]  # 한국 and 국 are inside it
    assert candidates(engine, "대한민국") == [("대한민국", ["大韓民國"])]
    assert candidates(engine, "오늘") == candidates(engine, "에") == []  # 오늘, 늘 and 에 have no Hanja
    assert engine.spans("학교에서") == [(0, 2), (3, 4)]
    assert engine.spans("대한민국에서") == [(0, 4), (5, 6)]


def test_of_words_as_long_the_one_nearest_the_caret_is_converted(tmp_path):
    engine = make(tmp_path)
    assert candidates(engine, "학교한국") == [("학교", []), ("한국", ["寒國", "寒菊", "韓國"])]
    assert candidates(engine, "한국학교") == [("한국", []), ("학교", ["學校", "學敎"])]
    assert candidates(engine, "서교")[0] == ("서", [])  # 서 and 교: the last


def test_resizing_converts_the_word_before_or_after_by_place(tmp_path):
    engine = make(tmp_path)
    # 학교 · 에 · 서: the next word with Hanja is 서, and back.
    assert candidates(engine, "학교에서", lengths=[2, 2], resize=(0, 1)) == [("학교에", []), ("서", ["西"])]
    assert candidates(engine, "학교에서", lengths=[3, 1], resize=(1, -1)) == [("학교", ["學校", "學敎"]), ("에서", [])]
    # None further that way: it stays.
    assert candidates(engine, "학교에서", lengths=[2, 2], resize=(0, -1))[0][0] == "학교"
    assert candidates(engine, "학교에서", lengths=[3, 1], resize=(1, 1))[1][0] == "서"
    # A cut that is not one of the words, or does not add up to the reading: the default word.
    assert candidates(engine, "학교에서", lengths=[1, 3], resize=(0, 1))[0][0] == "학교"
    assert candidates(engine, "학교에서", lengths=[2, 1], resize=(0, 1))[0][0] == "학교"
    assert candidates(engine, "학교에서", lengths=[2, 2], resize=(5, 1))[0][0] == "학교"


def test_a_pick_comes_first_for_its_word_and_is_kept_in_the_learned_file(tmp_path):
    engine = make(tmp_path)
    assert engine.learn("한국", [2], [2], ["韓國"]) is True
    assert candidates(engine, "한국") == [("한국", ["韓國", "寒國", "寒菊"])]
    assert engine.convert("한국")[0]["notes"] == ["대한민국", "", ""]  # notes follow their Hanja
    assert engine.learn("한국", [2], [1], ["寒菊"]) is True
    assert candidates(engine, "한국") == [("한국", ["寒菊", "韓國", "寒國"])]
    saved = tmp_path / "share" / "hanja-learned.json"
    assert json.loads(saved.read_text(encoding="utf-8")) == {"한국": ["寒菊", "韓國"]}
    # Another run reads it back.
    again = Hanja(tmp_path / "hanja.txt", saved)
    assert candidates(again, "한국") == [("한국", ["寒菊", "韓國", "寒國"])]


def test_only_a_hanja_of_the_word_is_learned(tmp_path):
    engine = make(tmp_path)
    assert engine.learn("한국", [2], [0], ["韓"]) is False  # not one of 한국's
    assert engine.learn("한국", [2], [0, 1], ["韓國", "寒國"]) is False
    assert engine.learn("없음", [2], [0], ["無"]) is False
    assert engine.learn_prediction("한국", "韓國") is False
    assert not (tmp_path / "share" / "hanja-learned.json").exists()


def test_the_learned_file_is_capped_the_least_recent_word_going_first(tmp_path, monkeypatch):
    monkeypatch.setattr(hanja_module, "MAX_LEARNED", 2)
    monkeypatch.setattr(hanja_module, "MAX_LEARNED_EACH", 2)
    engine = make(tmp_path)
    engine.learn("한", [1], [2], ["寒"])
    engine.learn("국", [1], [1], ["局"])
    engine.learn("한", [1], [1], ["漢"])  # 한 is the most recent now
    engine.learn("한국", [2], [2], ["韓國"])  # 국 goes
    saved = json.loads((tmp_path / "share" / "hanja-learned.json").read_text(encoding="utf-8"))
    assert saved == {"한": ["漢", "寒"], "한국": ["韓國"]}
    engine.learn("한", [1], [0], ["韓"])
    assert candidates(engine, "한") == [("한", ["韓", "漢", "寒"])]  # two kept for it: 韓, 漢
    saved = json.loads((tmp_path / "share" / "hanja-learned.json").read_text(encoding="utf-8"))
    assert saved["한"] == ["韓", "漢"]


def test_a_learned_file_that_is_broken_or_names_what_the_dictionary_lacks_is_ignored(tmp_path):
    learned = tmp_path / "share" / "hanja-learned.json"
    learned.parent.mkdir()
    for broken in ("{", "[1, 2]", '{"한국": "韓國"}', '{"한국": [1, null]}'):
        learned.write_text(broken, encoding="utf-8")
        assert candidates(Hanja(dictionary(tmp_path), learned), "한국") == [("한국", ["寒國", "寒菊", "韓國"])]
    learned.write_text(json.dumps({"한국": ["無", "韓國"]}), encoding="utf-8")
    assert candidates(Hanja(dictionary(tmp_path), learned), "한국") == [("한국", ["韓國", "寒國", "寒菊"])]


def test_a_missing_or_empty_dictionary_makes_the_converter_unavailable(tmp_path):
    with pytest.raises(HanjaUnavailable):
        Hanja(tmp_path / "none.txt", tmp_path / "learned.json")
    (tmp_path / "empty.txt").write_bytes(b"")
    with pytest.raises(HanjaUnavailable):
        Hanja(tmp_path / "empty.txt", tmp_path / "learned.json")
    # Only comments: it loads, and finds nothing.
    assert make(tmp_path, lines=[], header=HEADER, end="").convert("한") == []


def test_through_the_bridge_a_missing_dictionary_is_unavailable_and_nothing_typed_is_logged(tmp_path):
    out = io.StringIO()
    missing = Converter(lambda: Hanja(tmp_path / "none.txt", tmp_path / "learned.json"), "hanja", Log(out))
    found = Converter(lambda: make(tmp_path), "hanja", Log(out))

    def ask(converter, **request):
        bridge = Bridge(Log(out), converters=Converters({"hanja": converter}))
        return asyncio.run(bridge.handle(json.dumps({"id": 1, "converter": "hanja", **request})))

    assert ask(missing, op="convert", reading="한국")["error"] == "unavailable"
    assert ask(found, op="convert", reading="한국")["segments"][0]["candidates"] == ["寒國", "寒菊", "韓國"]
    assert ask(found, op="learn", reading="한국", lengths=[2], choices=[2], texts=["韓國"]) == {"id": 1, "ok": True}
    assert out.getvalue() == "hanja did not load: HanjaUnavailable\n"  # never the reading or the pick


def test_malformed_lines_are_skipped(tmp_path):
    lines = ["가:佳:", "한", "한:韓:", "한::", "한:漢", "한:\udcff:", "한국:韓國:"]
    path = tmp_path / "hanja.txt"
    path.write_bytes("\n".join(lines).encode("utf-8", errors="surrogateescape") + b"\n")
    engine = Hanja(path, tmp_path / "learned.json")
    assert candidates(engine, "한") == [("한", ["韓", "漢"])]  # no colon, no value, not UTF-8: skipped
    assert candidates(engine, "가") == [("가", ["佳"])]  # the first line
    assert candidates(engine, "한국") == [("한국", ["韓國"])]  # the last


def test_the_binary_search_finds_what_a_scan_finds(tmp_path):
    rng = random.Random(7)
    syllables = [chr(0xAC00 + rng.randrange(11172)) for _ in range(60)]
    keys = sorted(
        {"".join(rng.choice(syllables) for _ in range(rng.randint(1, 3))) for _ in range(400)}, key=str.encode
    )
    entries = {key: [chr(0x4E00 + rng.randrange(20000)) for _ in range(rng.randint(1, 3))] for key in keys}
    lines = [f"{key}:{value}:" for key in keys for value in dict.fromkeys(entries[key])]
    engine = make(tmp_path, lines=lines)
    for key in keys:
        assert engine.convert(key)[-1]["candidates"] == list(dict.fromkeys(entries[key]))
    for _ in range(200):
        absent = "".join(rng.choice(syllables) for _ in range(rng.randint(1, 3)))
        if absent not in entries:
            assert engine._entries(absent) == []
