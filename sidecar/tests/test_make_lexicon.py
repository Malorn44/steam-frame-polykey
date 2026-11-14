"""scripts/make-lexicon.py: the leipzig source on a tiny fixture, and the Korean list it built."""

import importlib.util
import json
import math
import re
import sys
import unicodedata
from pathlib import Path

import pytest
from polykey.lexicon import Lexicons
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


def test_leipzig_keeps_whole_words_of_the_letters_given_in_enough_corpora_summed_and_scaled(tmp_path):
    nfd = unicodedata.normalize("NFD", "학교")
    news = corpus(
        tmp_path,
        "kor_news_2022_1M",
        [("있다", 1000), (nfd, 300), ("한국", 50), ("김종담)는", 800), ("PPT발표와", 700)],
    )
    web = corpus(tmp_path, "kor-kr_web_2020_1M", [("있다", 500), ("학교", 100), ("ㅋㅋ", 600)])
    crawl = corpus(tmp_path, "kor_newscrawl_2016_1M", [("한국", 20), ("하나뿐", 400), ("가나다라마바사아자차카", 99)])
    header, entries = make_lexicon.leipzig("Korean", "[가-힣]", 10, 2, 2, [news, web, crawl])
    # 하나뿐 is in one corpus; ㅋㅋ, 김종담)는, PPT발표와 and 11 syllables are not whole words of [가-힣].
    assert [w for w, _ in entries] == ["있다", "학교"]  # NFC, counts summed (1500, 400), cut to 2
    assert entries[0][1] == 255 and entries[1][1] == round(255 + FREQUENCY_SCALE * math.log(400 / 1500))
    text = " ".join(line.removeprefix("# ") for line in header)
    assert header[0].startswith("# Korean word list") and all(len(line) <= 106 for line in header)
    assert "Collection's Korean news 2022, web 2020 and newscrawl 2016 word lists" in text
    assert "(https://wortschatz.uni-leipzig.de/en/download/kor), licensed CC BY 4.0" in text
    assert "1 to 10 letters [가-힣]" in text and "fewer than 2 of them" in text and "cut to the 2 most" in text
    header, entries = make_lexicon.leipzig("Korean", "[가-힣]", 10, 1, 9, [crawl])
    assert [w for w, _ in entries] == ["하나뿐", "한국"] and "newscrawl 2016 word list (" in " ".join(header)


def test_leipzig_refuses_other_files_and_corpora_of_more_than_one_language(tmp_path):
    korean, japanese = corpus(tmp_path, "kor_news_2022_1M", []), corpus(tmp_path, "jpn_news_2022_1M", [])
    with pytest.raises(SystemExit, match="more than one language: jpn, kor"):
        make_lexicon.leipzig("Korean", "[가-힣]", 10, 1, 9, [korean, japanese])
    with pytest.raises(SystemExit, match="not a Leipzig corpus word list"):
        make_lexicon.leipzig("Korean", "[가-힣]", 10, 1, 9, [str(tmp_path / "words.txt")])


def test_main_writes_the_header_then_the_words(tmp_path, capsys):
    one = corpus(tmp_path, "kor_news_2022_1M", [("있다", 10)])
    two = corpus(tmp_path, "kor-kr_web_2020_1M", [("있다", 5)])
    korean = ["--name", "Korean", "--letters", "[가-힣]", "--max-length", "10", "--min-corpora", "2", "--keep", "9"]
    assert make_lexicon.main(["leipzig", *korean, one, two]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[0].startswith("# Korean word list") and lines[-1] == "있다\t255"
    with pytest.raises(SystemExit):
        make_lexicon.main(["leipzig", "--name", "Korean", one])  # the language's letters and the rest are needed


def test_the_bundled_korean_list():
    path = REPO / "packs" / "ko" / "words.tsv"
    lines = path.read_text(encoding="utf-8").splitlines()
    header = [line for line in lines if line.startswith("#")]
    entries = [line.split("\t") for line in lines if line and not line.startswith("#")]
    assert len(entries) == 60_000 and "Leipzig Corpora Collection" in header[1] and "CC BY 4.0" in header[2]
    assert all(re.fullmatch("[가-힣]{1,10}", w) and unicodedata.is_normalized("NFC", w) for w, _ in entries)
    frequencies = [int(f) for _, f in entries]
    assert frequencies == sorted(frequencies, reverse=True) and frequencies[0] == 255 and frequencies[-1] >= 0
    hangul = HangulSpeller(json.loads((REPO / "packs" / "ko" / "hangul.json").read_text(encoding="utf-8"))["hangul"])
    lexicon = Lexicons([REPO / "packs"]).get("ko/words")  # under the size cap
    assert len(lexicon) == 60_000 and lexicon.suggest("한ㄱ", 1, hangul) == ["한국"]
    assert {"학교에서", "학교를"} <= set(lexicon.suggest("학교", 8, hangul))
