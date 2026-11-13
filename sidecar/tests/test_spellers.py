"""Spellers: text as the keys it is typed with, so suggestions match what is typed (하 → 한국)."""

import asyncio
import io
import json
from pathlib import Path

from polykey import packs
from polykey.bridge import Bridge
from polykey.injector import Log
from polykey.lexicon import Lexicon, Lexicons
from polykey.spellers import SPELLERS, Spellers
from polykey.spellers.hangul import HangulSpeller

PACKS = Path(__file__).resolve().parents[2] / "packs"
HANGUL = packs.read_json((PACKS / "ko" / "hangul.json").read_text(encoding="utf-8"))
SPELLER = HangulSpeller(HANGUL["hangul"])
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


def test_every_syllable_is_spelled_with_the_2set_layouts_keys():
    catalog = packs.load(PACKS, PACKS / "pack.schema.json", user=Path("/nonexistent"))["catalog"]
    keys: set[str] = set()
    for row in catalog["layouts"]["ko/dubeolsik"]["rows"]:
        for key in row:
            keys.update([key] if isinstance(key, str) else [key.get("char", ""), key.get("shift", "")])
    spelled = {SPELLER.spell(chr(code)) for code in range(0xAC00, 0xD7A4)}
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
    assert lexicon.complete("한", 5) == ["한국"]  # without a speller: the text
    assert complete("hel") == ["hello"]  # text the speller does not spell: the text


def test_spellers_follow_the_schemas_table_formats_and_the_tables_loaded():
    schema = json.loads((PACKS / "pack.schema.json").read_text(encoding="utf-8"))["$defs"]["table"]
    formats = [field for option in schema["oneOf"] for field in option["required"]]
    assert set(SPELLERS) <= set(formats)
    tables = {"ko/hangul": HANGUL, "ja/romaji-table": {"entries": [["ka", "か"]]}}
    spellers = Spellers(lambda: tables)
    hangul = spellers.get("ko/hangul")
    assert isinstance(hangul, HangulSpeller) and spellers.get("ko/hangul") is hangul
    assert spellers.get("ja/romaji-table") is None and spellers.get("nope/none") is None
    tables["ko/hangul"] = {**HANGUL, "hangul": {}}  # loaded anew (the next injection): spelled anew
    assert spellers.get("ko/hangul") is not hangul and spellers.get("ko/hangul").spell("과") == "ㄱㅘ"


def test_the_bundled_tables_are_the_loaded_ones():
    boot = packs.load(PACKS, PACKS / "pack.schema.json", user=Path("/nonexistent"))
    assert packs.loaded_tables() is boot["catalog"]["tables"] and "ko/hangul" in packs.loaded_tables()


def test_suggest_names_the_keyboards_table_and_never_logs_the_prefix(tmp_path):
    (tmp_path / "ko").mkdir()
    (tmp_path / "ko" / "words.tsv").write_text(WORDS, encoding="utf-8")
    out = io.StringIO()
    bridge = Bridge(Log(out), None, Lexicons([tmp_path]), spellers=Spellers(lambda: {"ko/hangul": HANGUL}))

    async def main():
        ask = lambda **f: bridge.handle(json.dumps({"id": 1, "op": "suggest", "lexicon": "ko/words", **f}))
        assert (await ask(prefix="한", table="ko/hangul", limit=3))["words"] == ["한국", "하나"]
        assert (await ask(prefix="한", limit=3))["words"] == ["한국"]  # no table: the text
        assert (await ask(prefix="한", table="ko/none", limit=3))["words"] == ["한국"]
        assert (await ask(prefix="한", table=["ko/hangul"], limit=3))["words"] == ["한국"]

    asyncio.run(main())
    assert "한" not in out.getvalue()
