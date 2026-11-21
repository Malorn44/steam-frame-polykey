"""Spellers: text as the keys it is typed with, so suggestions match what is typed (하 → 한국)."""

import asyncio
import io
import json
from pathlib import Path

import pytest

from polykey import packs
from polykey.bridge import Bridge
from polykey.injector import Log
from polykey.lexicon import Lexicon, Lexicons
from polykey.packs import COMPOSER_TABLES
from polykey.spellers import LOWERCASE, SPELLERS, Spellers
from polykey.spellers.hangul import HangulSpeller

PACKS = Path(__file__).resolve().parents[2] / "packs"
HANGUL = packs.read_json((PACKS / "ko" / "hangul.json").read_text(encoding="utf-8"))
SPELLER = HangulSpeller(HANGUL["hangul"])
CATALOG = packs.load(PACKS, PACKS / "pack.schema.json", user=Path("/nonexistent"))["catalog"]
BUNDLED_SPELLERS = Spellers(lambda: CATALOG)


def typed_by(key: str | dict) -> set[str]:
    """Everything a key types: its char and Shift's, its flicks, its tap cycle and what holding it offers."""
    if isinstance(key, str):
        return {key}
    return {key.get("char", ""), key.get("shift", "")} | {
        *key.get("flick", {}).values(),
        *key.get("cycle", []),
        *key.get("long", []),
    }


WORDS = (
    "한국\t200\n하나\t150\n하고\t300\n학교\t120\n달걀\t40\n닭\t30\n과일\t60\n고기\t50\n감사\t90\n가방\t20\nhello\t10\n"
)


def test_hangul_is_spelled_as_the_keys_typed():
    assert SPELLER.spell("한국") == "ㅎㅏㄴㄱㅜㄱ"
    assert SPELLER.spell("하나") == "ㅎㅏㄴㅏ"  # 한's final and 하나's initial ㄴ are one key
    assert SPELLER.spell("과일") == "ㄱㅗㅏㅇㅣㄹ"  # a compound vowel: two keys
    assert SPELLER.spell("닭") == "ㄷㅏㄹㄱ"  # a compound final: two keys
    assert SPELLER.spell("뷁") == "ㅂㅜㅔㄹㄱ"
    assert SPELLER.spell("했다") == "ㅎㅐㅆㄷㅏ"  # ㅆ is one key, with Shift
    assert SPELLER.spell("ㄱ") == "ㄱ" and SPELLER.spell("ㅘ") == "ㅗㅏ" and SPELLER.spell("ㄳ") == "ㄱㅅ"  # jamo alone
    assert SPELLER.spell("한ㄱ") == "ㅎㅏㄴㄱ"  # a syllable sent, a jamo composing
    assert SPELLER.spell("한a") is None and SPELLER.spell("hello") is None


@pytest.mark.parametrize(
    "keyboard_id", sorted(k for k in CATALOG["keyboards"] if isinstance(BUNDLED_SPELLERS.get(k), HangulSpeller))
)
def test_every_syllable_is_spelled_with_the_keyboards_keys(keyboard_id):
    rows = CATALOG["layouts"][CATALOG["keyboards"][keyboard_id]["layout"]]["rows"]
    keys = {typed for row in rows for key in row for typed in typed_by(key)}
    spelled = {BUNDLED_SPELLERS.get(keyboard_id).spell(chr(code)) for code in range(0xAC00, 0xD7A4)}
    assert None not in spelled and len(spelled) == 11_172  # each syllable its own keys
    assert set("".join(spelled)) <= keys


def test_prefixes_complete_on_the_keys_typed():
    lexicon = Lexicon.parse(WORDS)
    complete = lambda prefix, limit=5: lexicon.complete(prefix, limit, SPELLER)
    assert complete("하") == ["하고", "한국", "하나", "학교"]  # by count
    assert complete("한") == ["한국", "하나"]
    assert complete("학") == ["하고", "학교"]
    assert complete("닭") == ["달걀", "닭"]
    assert complete("고") == ["과일", "고기"]
    assert complete("ㄱ") == ["감사", "과일", "고기", "가방"]
    assert complete("한구") == ["한국"] and complete("한국어") == []
    assert lexicon.complete("한", 5) == ["한국"]  # the default speller: the text
    assert complete("hel") == [] and lexicon.complete("hel", 5) == ["hello"]  # Latin is not Hangul


def test_cheonjiin_spells_vowels_as_their_strokes():
    table = packs.read_json((PACKS / "ko" / "hangul-cheonjiin.json").read_text(encoding="utf-8"))["hangul"]
    speller = SPELLERS["hangul-2set"](table)
    assert speller.spell("ㄱㆍ") == "ㄱㆍ" and speller.spell("ㄱᆢ") == "ㄱㆍㆍ"  # strokes that make no vowel yet
    complete = lambda prefix: Lexicon.parse(WORDS).complete(prefix, 5, speller)
    assert complete("ㄱㆍ") == ["과일", "고기"] and complete("기") == ["감사", "가방"]  # 기 is on the way to 가


def test_spellers_are_by_composer_and_spell_with_the_keyboards_table():
    schema = json.loads((PACKS / "pack.schema.json").read_text(encoding="utf-8"))["$defs"]["keyboard"]
    assert set(SPELLERS) <= set(schema["properties"]["composer"]["enum"]) and set(SPELLERS) <= set(COMPOSER_TABLES)
    hangul_2set = {"composer": "hangul-2set", "table": "ko/hangul"}
    catalog = {
        "keyboards": {"ko/korean": hangul_2set, "ko/other": hangul_2set, "ja/romaji": {"composer": "romaji"}},
        "tables": {"ko/hangul": HANGUL},
    }
    spellers = Spellers(lambda: catalog)
    hangul = spellers.get("ko/korean")
    assert isinstance(hangul, HangulSpeller) and spellers.get("ko/korean") is hangul is spellers.get("ko/other")
    assert spellers.get("ja/romaji") is LOWERCASE and spellers.get("nope/none") is LOWERCASE
    catalog["tables"]["ko/hangul"] = {**HANGUL, "hangul": {}}  # loaded anew (the next injection): spelled anew
    assert spellers.get("ko/korean") is not hangul and spellers.get("ko/korean").spell("과") == "ㄱㅘ"


def test_a_keyboard_whose_table_makes_more_jamo_of_two_spells_them_so(tmp_path):
    # A single-vowel (단모음) keyboard of the user's: ㅏ ㅏ is ㅑ, ㅑ ㅣ is ㅒ, ㄱ ㄱ is ㄲ. No code knows it.
    table = dict(HANGUL, id="mine/single-table", name="mine")
    table["hangul"] = {
        **HANGUL["hangul"],
        "compoundMedials": [*HANGUL["hangul"]["compoundMedials"], "ㅏㅏㅑ", "ㅑㅣㅒ"],
    }
    table["hangul"]["compoundFinals"] = [*HANGUL["hangul"]["compoundFinals"], "ㄱㄱㄲ"]
    keyboard = {"schemaVersion": 1, "kind": "keyboard", "id": "mine/single", "name": "mine", "extends": "ko/korean"}
    (tmp_path / "packs" / "mine").mkdir(parents=True)
    (tmp_path / "packs" / "mine" / "table.json").write_text(json.dumps(table), encoding="utf-8")
    (tmp_path / "packs" / "mine" / "single.json").write_text(json.dumps({**keyboard, "table": "mine/single-table"}))
    assert packs.load(PACKS, PACKS / "pack.schema.json", user=tmp_path)["errors"] == []
    single = Spellers(packs.loaded_catalog).get("mine/single")
    assert (single.spell("야"), single.spell("얘"), single.spell("까")) == ("ㅇㅏㅏ", "ㅇㅏㅏㅣ", "ㄱㄱㅏ")
    lexicon = Lexicon.parse("야구\t90\n아이\t80\n까치\t10\n")
    assert lexicon.complete("아", 5, single) == ["야구", "아이"] and lexicon.complete("ㄲ", 5, single) == ["까치"]
    assert lexicon.complete("아", 5, Spellers(packs.loaded_catalog).get("ko/korean")) == ["아이"]  # 2-set: ㅑ is a key


def test_the_loaded_catalog_is_the_boots():
    boot = packs.load(PACKS, PACKS / "pack.schema.json", user=Path("/nonexistent"))
    assert packs.loaded_catalog() is boot["catalog"]
    assert isinstance(Spellers(packs.loaded_catalog).get("ko/korean"), HangulSpeller)


def test_suggest_names_the_keyboard_and_never_logs_the_prefix(tmp_path):
    (tmp_path / "ko").mkdir()
    (tmp_path / "ko" / "words.tsv").write_text(WORDS, encoding="utf-8")
    out = io.StringIO()
    catalog = {
        "keyboards": {"ko/korean": {"composer": "hangul-2set", "table": "ko/hangul"}},
        "tables": {"ko/hangul": HANGUL},
    }
    bridge = Bridge(Log(out), None, Lexicons([tmp_path]), spellers=Spellers(lambda: catalog))

    async def main():
        ask = lambda **f: bridge.handle(json.dumps({"id": 1, "op": "suggest", "lexicon": "ko/words", **f}))
        assert (await ask(prefix="한", keyboard="ko/korean", limit=3))["words"] == ["한국", "하나"]
        assert (await ask(prefix="한", limit=3))["words"] == ["한국"]  # no keyboard: the text
        assert (await ask(prefix="한", keyboard="ko/none", limit=3))["words"] == ["한국"]
        assert (await ask(prefix="한", keyboard=["ko/korean"], limit=3))["words"] == ["한국"]

    asyncio.run(main())
    assert "한" not in out.getvalue()


def test_a_keyboard_drawn_prepares_its_list_once_and_suggestions_reuse_it(tmp_path):
    (tmp_path / "ko").mkdir()
    (tmp_path / "ko" / "words.tsv").write_text(WORDS, encoding="utf-8")
    out = io.StringIO()
    lexicons = Lexicons([tmp_path])
    catalog = {
        "keyboards": {"ko/korean": {"composer": "hangul-2set", "table": "ko/hangul"}},
        "tables": {"ko/hangul": HANGUL},
    }
    spellers = Spellers(lambda: catalog)
    bridge = Bridge(Log(out), None, lexicons, spellers=spellers)

    async def main():
        ask = lambda **f: bridge.handle(json.dumps({"id": 1, "op": "suggest", "lexicon": "ko/words", **f}))
        assert await ask(prepare=True, keyboard="ko/korean") == {"id": 1, "ok": True, "words": []}
        assert (await ask(prepare=True, keyboard="ko/korean"))["ok"]  # built already: nothing to do
        assert (await ask(prefix="한", keyboard="ko/korean", limit=3))["words"] == ["한국", "하나"]
        assert not lexicons.get("ko/words").prepare(spellers.get("ko/korean"))  # the suggestion used that index
        assert (await ask(prepare=True))["ok"]  # no keyboard: for LOWERCASE, as English is
        assert (await ask(prepare=True, lexicon="ko/none"))["error"] == "no-lexicon"

    asyncio.run(main())
    ready = [line for line in out.getvalue().splitlines() if "suggest: ko/words ready in" in line]
    assert len(ready) == 2 and "한" not in out.getvalue()  # once a speller; the list's id only
