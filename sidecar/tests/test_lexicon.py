from __future__ import annotations

import asyncio
import io
import json

from polykey.bridge import Bridge
from polykey.injector import Log
from polykey.lexicon import UNUSED_S, Lexicon, Lexicons

WORDS = "# test list\nthe\t1000\nthey\t300\nthen\t200\nthere\t250\nThe\t5\nhello\t50\nhelp\t80\nHelsinki\t20\nbad line\tnope\n"


def test_completes_by_count_case_insensitively():
    lexicon = Lexicon.parse(WORDS)
    assert lexicon.complete("the", 3) == ["the", "they", "there"]
    assert lexicon.complete("hel", 5) == ["help", "hello", "Helsinki"]
    assert lexicon.complete("Hel", 5) == ["help", "hello", "Helsinki"]
    assert lexicon.complete("xyz", 3) == []
    assert lexicon.complete("", 3) == []
    capitals = Lexicon.parse("OK\t400\nokay\t300\niPhone\t50\nMcDonald\t40\nUS\t30\nus\t30\nuse\t20\n")
    assert capitals.complete("ok", 3) == capitals.complete("OK", 3) == ["OK", "okay"]  # whatever the case
    assert capitals.complete("iph", 3) == ["iPhone"] and capitals.complete("mcd", 3) == ["McDonald"]
    assert capitals.complete("us", 3) == ["us", "US", "use"]  # a tie: lower case first


def test_corrects_likely_slips_ranked_with_completions():
    lexicon = Lexicon.parse(
        "the\t250\nten\t150\nhello\t150\nhelots\t10\nhelp\t160\nbecause\t200\ndon't\t180\nTehran\t60\n"
    )
    assert lexicon.correct("teh") == ["the", "ten"]  # swapped letters, then a replaced one
    assert lexicon.suggest("helo", 3) == ["hello", "help", "helots"]  # a doubled letter beats a rare completion
    assert lexicon.suggest("becuase", 3) == ["because"]
    assert lexicon.suggest("dont", 3) == ["don't"]
    assert lexicon.correct("bcause") == ["because"]  # one edit: an insert
    assert lexicon.correct("x") == [] and lexicon.correct("4th") == []


def test_skips_comments_and_bad_lines():
    lexicon = Lexicon.parse(WORDS)
    assert len(lexicon) == 8  # "The" kept as its own entry, the bad line dropped


def test_user_lists_replace_bundled_ones(tmp_path):
    (tmp_path / "user" / "en").mkdir(parents=True)
    (tmp_path / "bundled" / "en").mkdir(parents=True)
    (tmp_path / "bundled" / "en" / "words.tsv").write_text("apple\t1\n", encoding="utf-8")
    lexicons = Lexicons([tmp_path / "user", tmp_path / "bundled"])
    assert lexicons.get("en/words").complete("ap", 3) == ["apple"]
    (tmp_path / "user" / "en" / "words.tsv").write_text("apricot\t1\n", encoding="utf-8")
    assert Lexicons([tmp_path / "user", tmp_path / "bundled"]).get("en/words").complete("ap", 3) == ["apricot"]
    assert lexicons.get("../etc") is None
    assert lexicons.get("en/missing") is None


def test_a_list_unused_for_ten_minutes_is_dropped_and_the_next_request_loads_it(tmp_path):
    (tmp_path / "en").mkdir()
    (tmp_path / "en" / "words.tsv").write_text(WORDS, encoding="utf-8")
    now = [0.0]
    lexicons = Lexicons([tmp_path], clock=lambda: now[0])
    first = lexicons.get("en/words")
    assert lexicons.get("en/missing") is None  # not found: never reported as dropped
    now[0] = UNUSED_S - 1
    assert lexicons.unload_unused() == {} and lexicons.get("en/words") is first  # used within the limit: kept
    now[0] = 2 * UNUSED_S - 2
    assert lexicons.unload_unused() == {}  # last used UNUSED_S - 1 ago
    now[0] = 2 * UNUSED_S
    assert lexicons.unload_unused() == {"en/words": UNUSED_S + 1}
    again = lexicons.get("en/words")
    assert again is not first and again.complete("hel", 2) == ["help", "hello"]  # loaded anew


def test_the_bridge_logs_a_list_unloaded_once_and_a_suggest_loads_it_again(tmp_path):
    (tmp_path / "en").mkdir()
    (tmp_path / "en" / "words.tsv").write_text(WORDS, encoding="utf-8")
    now, out = [0.0], io.StringIO()
    bridge = Bridge(Log(out), None, Lexicons([tmp_path], clock=lambda: now[0]))
    ask = lambda **f: asyncio.run(bridge.handle(json.dumps({"id": 1, "op": "suggest", "lexicon": "en/words", **f})))
    assert ask(prepare=True)["ok"]
    now[0] = UNUSED_S + 30
    bridge.unload_unused()
    bridge.unload_unused()
    assert ask(prefix="hel", limit=2)["words"] == ["help", "hello"]
    unloaded = [line for line in out.getvalue().splitlines() if "unloaded" in line]
    assert len(unloaded) == 1 and unloaded[0].endswith("suggest: en/words unloaded after 10 min unused")
    assert "hel" not in out.getvalue()


def test_suggest_through_the_bridge_never_logs_the_prefix(tmp_path):
    (tmp_path / "en").mkdir()
    (tmp_path / "en" / "words.tsv").write_text(WORDS, encoding="utf-8")
    out = io.StringIO()
    bridge = Bridge(Log(out), None, Lexicons([tmp_path]))

    async def main():
        ask = lambda **f: bridge.handle(json.dumps({"id": 1, "op": "suggest", **f}))
        assert await ask(prefix="hel", lexicon="en/words", limit=2) == {"id": 1, "ok": True, "words": ["help", "hello"]}
        assert (await ask(prefix="", lexicon="en/words"))["error"] == "bad-prefix"
        assert (await ask(prefix="x", lexicon="en/words", limit=99))["error"] == "bad-limit"
        assert (await ask(prefix="x", lexicon="en/none"))["error"] == "no-lexicon"

    asyncio.run(main())
    assert "hel" not in out.getvalue()


def test_blocked_words_are_never_suggested_but_profanity_is(tmp_path):
    from polykey.lexicon import word_hash

    (tmp_path / "bundled" / "en").mkdir(parents=True)
    (tmp_path / "user" / "en").mkdir(parents=True)
    (tmp_path / "bundled" / "en" / "words.tsv").write_text(
        "badword\t9\nbadword's\t8\nbadge\t5\nfuck\t7\n", encoding="utf-8"
    )
    (tmp_path / "bundled" / "en" / "blocked.sha256").write_text(f"# hashes\n{word_hash('badword')}\n", encoding="utf-8")
    (tmp_path / "user" / "en" / "blocked.txt").write_text("# mine\nbadge\n", encoding="utf-8")
    lexicon = Lexicons([tmp_path / "user", tmp_path / "bundled"]).get("en/words")
    assert lexicon.complete("bad", 5) == []  # hashed block covers the possessive; the user blocked "badge"
    assert lexicon.complete("fu", 5) == ["fuck"]


def test_bundled_english_list_is_clean_and_keeps_profanity():
    from pathlib import Path
    from polykey.lexicon import word_hash

    packs = Path(__file__).resolve().parents[2] / "packs"
    blocked = {l.strip() for l in (packs / "en" / "blocked.sha256").read_text().splitlines() if not l.startswith("#")}
    words = [
        l.split("\t")[0] for l in (packs / "en" / "words.tsv").read_text().splitlines() if l and not l.startswith("#")
    ]
    assert len(words) == 60_000
    assert not any(word_hash(w) in blocked for w in words)
    assert Lexicons([packs]).get("en/words").complete("fuc", 1) == ["fuck"]
