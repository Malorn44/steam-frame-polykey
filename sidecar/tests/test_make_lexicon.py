"""scripts/make-lexicon.py: the leipzig source on a tiny fixture, and the blocklist's prefix rule."""

import importlib.util
import json
import math
import sys
import unicodedata
from pathlib import Path

from polykey.lexicon import Lexicons, word_hash
from polykey.spellers.hangul import HangulSpeller
from polykey.swipe import FREQUENCY_SCALE

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("make_lexicon", REPO / "scripts" / "make-lexicon.py")
make_lexicon = sys.modules["make_lexicon"] = importlib.util.module_from_spec(spec)
spec.loader.exec_module(make_lexicon)


def corpus(directory: Path, name: str, rows: list[tuple[str, int]]) -> str:
    path = directory / f"{name}-words.txt"
    path.write_text("".join(f"{i}\t{w}\t{c}\n" for i, (w, c) in enumerate(rows, 1)) + "bad line\n", encoding="utf-8")
    return str(path)


def test_a_blocked_word_blocks_the_words_it_starts_from_two_syllables():
    blocked = {word_hash("나쁜말"), word_hash("개")}
    is_blocked = make_lexicon.is_blocked
    assert (
        is_blocked("나쁜말", blocked, 2) and is_blocked("나쁜말이", blocked, 2) and is_blocked("나쁜말들을", blocked, 2)
    )
    assert not is_blocked("나쁜", blocked, 2)  # a word it starts with is not blocked
    assert is_blocked("개", blocked, 2) and not is_blocked("개가", blocked, 2)  # one syllable: only itself
    assert not is_blocked("나쁜말이", blocked)  # without stems (English): only the word itself


def test_leipzig_keeps_whole_hangul_words_in_two_corpora_summed_and_scaled(tmp_path, monkeypatch, capsys):
    blocked = tmp_path / "blocked.sha256"
    blocked.write_text(f"# hashes\n{word_hash('나쁜말')}\n", encoding="utf-8")
    nfd = unicodedata.normalize("NFD", "학교")
    news = corpus(
        tmp_path,
        "kor_news_2022_1M",
        [("있다", 1000), (nfd, 300), ("한국", 50), ("나쁜말이", 900), ("김종담)는", 800), ("PPT발표와", 700)],
    )
    web = corpus(tmp_path, "kor-kr_web_2020_1M", [("있다", 500), ("학교", 100), ("ㅋㅋ", 600), ("나쁜말이", 9)])
    crawl = corpus(tmp_path, "kor_newscrawl_2016_1M", [("한국", 20), ("하나뿐", 400), ("가나다라마바사아자차카", 99)])
    monkeypatch.setattr(make_lexicon, "KEEP", 2)
    header, entries = make_lexicon.leipzig("ko", str(blocked), news, web, crawl)
    # 하나뿐 is in one corpus; ㅋㅋ, 김종담)는, PPT발표와 and 11 syllables are not whole Hangul words; 나쁜말이 is blocked.
    assert [w for w, _ in entries] == ["있다", "학교"]  # NFC, counts summed (1500, 400), cut to KEEP
    assert entries[0][1] == 255 and entries[1][1] == round(255 + FREQUENCY_SCALE * math.log(400 / 1500))
    assert "1 blocked words dropped, the first at rank 2" in capsys.readouterr().err
    assert header[1] == (
        "# Derived from the Leipzig Corpora Collection's Korean news 2022, web 2020 and newscrawl 2016 word lists"
    )
    assert "https://wortschatz.uni-leipzig.de/en/download/kor" in header[2] and "CC BY 4.0" in header[2]
    assert "counts summed" in header[3] and "blocked words removed" in header[4] and "cut to the 2" in header[4]


def test_main_writes_the_header_then_the_words(tmp_path, capsys):
    blocked = tmp_path / "blocked.sha256"
    blocked.write_text("", encoding="utf-8")
    one = corpus(tmp_path, "kor_news_2022_1M", [("있다", 10)])
    two = corpus(tmp_path, "kor-kr_web_2020_1M", [("있다", 5)])
    assert make_lexicon.main(["leipzig", "ko", str(blocked), one, two]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[0].startswith("# Korean word list") and lines[-1] == "있다\t255"
    assert make_lexicon.main(["nope"]) == 2


def test_the_bundled_korean_list():
    path = REPO / "packs" / "ko" / "words.tsv"
    lines = path.read_text(encoding="utf-8").splitlines()
    header = [line for line in lines if line.startswith("#")]
    entries = [line.split("\t") for line in lines if line and not line.startswith("#")]
    assert len(entries) == 60_000 and "Leipzig Corpora Collection" in header[1] and "CC BY 4.0" in header[2]
    korean = make_lexicon.LEIPZIG["ko"]
    assert all(korean.word.fullmatch(w) and unicodedata.is_normalized("NFC", w) for w, _ in entries)
    frequencies = [int(f) for _, f in entries]
    assert frequencies == sorted(frequencies, reverse=True) and frequencies[0] == 255 and frequencies[-1] >= 0
    blocked = make_lexicon.read_blocked(str(REPO / "packs" / "ko" / "blocked.sha256"))
    assert blocked and not any(make_lexicon.is_blocked(w, blocked, korean.stems) for w, _ in entries)
    hangul = HangulSpeller(json.loads((REPO / "packs" / "ko" / "hangul.json").read_text(encoding="utf-8"))["hangul"])
    lexicon = Lexicons([REPO / "packs"]).get("ko/words")  # under the size cap, with its blocklist
    assert len(lexicon) == 60_000 and lexicon.suggest("한ㄱ", 1, hangul) == ["한국"]
    assert {"학교에서", "학교를"} <= set(lexicon.suggest("학교", 8, hangul))
