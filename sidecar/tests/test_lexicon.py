from __future__ import annotations

import asyncio
import io
import json

from polykey.bridge import Bridge
from polykey.injector import Log
from polykey.lexicon import Lexicon, Lexicons

WORDS = "# test list\nthe\t1000\nthey\t300\nthen\t200\nthere\t250\nThe\t5\nhello\t50\nhelp\t80\nHelsinki\t20\nbad line\tnope\n"


def test_completes_by_count_case_insensitively():
    lexicon = Lexicon.parse(WORDS)
    assert lexicon.complete("the", 3) == ["the", "they", "there"]
    assert lexicon.complete("hel", 5) == ["help", "hello", "Helsinki"]
    assert lexicon.complete("Hel", 5) == ["help", "hello", "Helsinki"]
    assert lexicon.complete("xyz", 3) == []
    assert lexicon.complete("", 3) == []


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
    (tmp_path / "bundled" / "en" / "words.tsv").write_text("badword\t9\nbadword's\t8\nbadge\t5\nfuck\t7\n", encoding="utf-8")
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
    words = [l.split("\t")[0] for l in (packs / "en" / "words.tsv").read_text().splitlines() if l and not l.startswith("#")]
    assert len(words) == 60_000
    assert not any(word_hash(w) in blocked for w in words)
    assert Lexicons([packs]).get("en/words").complete("fuc", 1) == ["fuck"]
