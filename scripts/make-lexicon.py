#!/usr/bin/env python3
"""Build a word list for suggestions, packs/<ns>/words.tsv, from a source's word frequencies.

Usage:
  python3 scripts/make-lexicon.py aosp en_US_wordlist.combined.gz packs/en/blocked.sha256 > packs/en/words.tsv
  python3 -I scripts/make-lexicon.py leipzig ko packs/ko/blocked.sha256 kor_news_2022_1M-words.txt \\
      kor-kr_web_2020_1M-words.txt kor_newscrawl_2016_1M-words.txt > packs/ko/words.tsv

aosp: AOSP LatinIME's word list (Apache-2.0), from
https://android.googlesource.com/platform/packages/inputmethods/LatinIME/+/refs/heads/main/dictionaries/.
Keeps the most frequent words (profanity included), drops blocked words and AOSP's not-a-word entries.

leipzig: the word lists (*-words.txt: id, word, count) of Leipzig Corpora Collection corpora in one
language (CC BY 4.0), from https://wortschatz.uni-leipzig.de/en/download. They are downloaded data: run
this with python3 -I. Words are taken in NFC, and only whole words of the language's letters (LEIPZIG)
are kept, their counts summed over the corpora, and only those found in at least two of them. Blocked
words are dropped; where words carry their particles and endings (Korean), so is every word starting
with a blocked word that long or longer (slur + 가). Counts are scaled to 0-255 as AOSP's are, and the
most frequent words kept. stderr says how many blocked words would have been in the list (never which).
"""

from __future__ import annotations

import gzip
import math
import re
import sys
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
from polykey.lexicon import word_hash
from polykey.swipe import FREQUENCY_SCALE

KEEP = 60_000
HEADER = "# {name} word list for polykey suggestions: word<TAB>frequency (0-255), most frequent first."


@dataclass(frozen=True)
class Language:
    """How the leipzig source reads one language's word lists."""

    name: str
    # Leipzig's code for it (ISO 639-3), as in its download page's address.
    code: str
    # A word kept whole, and how the header says so.
    word: re.Pattern
    kept: str
    # Blocked words block the words they start from this many letters (0: only themselves).
    stems: int = 0


LEIPZIG = {
    # Hangul syllables only: no digits, Latin or punctuation stuck to a word (김종담)는), no lone jamo.
    "ko": Language("Korean", "kor", re.compile(r"[가-힣]{1,10}"), "Hangul words of 1-10 syllables", stems=2),
}
# Words found in fewer corpora than this are dropped (one corpus's typos and names).
MIN_CORPORA = 2


def read_blocked(path: str) -> set[str]:
    return {line.strip() for line in Path(path).read_text(encoding="utf-8").splitlines() if not line.startswith("#")}


def is_blocked(word: str, blocked: set[str], stems: int = 0) -> bool:
    """A blocked word, or (stems > 0) one starting with a blocked word of `stems` letters or more."""
    if word_hash(word) in blocked:
        return True
    return stems > 0 and any(word_hash(word[:n]) in blocked for n in range(stems, len(word)))


def scaled(counts: dict[str, int]) -> dict[str, int]:
    """Counts as 0-255 frequencies, as AOSP's word lists have them: FREQUENCY_SCALE steps per natural-log
    unit of count, the most frequent word 255."""
    top = max(counts.values(), default=1)
    return {w: max(0, round(255 + FREQUENCY_SCALE * math.log(c / top))) for w, c in counts.items()}


def aosp(source: str, blocked_path: str) -> tuple[list[str], list[tuple[str, int]]]:
    blocked = read_blocked(blocked_path)
    entries = []
    with gzip.open(source, "rt", encoding="utf-8") as lines:
        for line in lines:
            m = re.match(r" word=([^,]+),f=(\d+),flags=([^,]*)(.*)", line)
            if not m or "not_a_word=true" in m.group(4) or is_blocked(m.group(1), blocked):
                continue
            entries.append((m.group(1), int(m.group(2))))
    entries.sort(key=lambda e: -e[1])  # stable: AOSP order breaks ties
    header = [
        HEADER.format(name="English"),
        "# Derived from AOSP LatinIME dictionaries/en_US_wordlist.combined.gz (version 54, 2014):",
        "# Copyright (c) 2008, The Android Open Source Project. Licensed under the Apache License 2.0;",
        "# see packs/en/LICENSE.words. Modified: cut to the most frequent words, blocked words removed.",
    ]
    return header, entries[:KEEP]


def corpus_name(path: str) -> str:
    """kor_news_2022_1M-words.txt: news 2022."""
    m = re.match(r"[a-z]{3}(?:-[a-z]{2})?_([a-z]+)_(\d{4})_", Path(path).name)
    return f"{m.group(1)} {m.group(2)}" if m else Path(path).name


def leipzig(code: str, blocked_path: str, *sources: str) -> tuple[list[str], list[tuple[str, int]]]:
    language = LEIPZIG[code]
    blocked = read_blocked(blocked_path)
    counts: Counter[str] = Counter()
    corpora: Counter[str] = Counter()  # how many corpora each word is in
    for source in sources:
        mine: Counter[str] = Counter()
        with open(source, encoding="utf-8") as lines:
            for line in lines:
                parts = line.rstrip("\n").split("\t")
                if len(parts) != 3 or not parts[2].isdigit():
                    continue
                word = unicodedata.normalize("NFC", parts[1])
                if language.word.fullmatch(word):
                    mine[word] += int(parts[2])
        counts.update(mine)
        corpora.update(mine.keys())
    ranked = sorted((w for w in counts if corpora[w] >= MIN_CORPORA), key=lambda w: (-counts[w], w))
    kept: list[str] = []
    dropped: list[int] = []  # ranks among the kept words, had they not been blocked
    for word in ranked:
        if len(kept) == KEEP:
            break
        if is_blocked(word, blocked, language.stems):
            dropped.append(len(kept) + len(dropped) + 1)
        else:
            kept.append(word)
    print(
        f"{len(dropped)} blocked words dropped" + (f", the first at rank {dropped[0]}" if dropped else ""),
        file=sys.stderr,
    )
    frequency = scaled({w: counts[w] for w in kept})
    names = [corpus_name(s) for s in sources]
    header = [
        HEADER.format(name=language.name),
        f"# Derived from the Leipzig Corpora Collection's {language.name} {', '.join(names[:-1])} and {names[-1]} word lists"
        if len(names) > 1
        else f"# Derived from the Leipzig Corpora Collection's {language.name} {names[0]} word list",
        f"# (https://wortschatz.uni-leipzig.de/en/download/{language.code}), licensed CC BY 4.0; see packs/{code}/LICENSE.words.",
        f"# Modified: {language.kept} only (NFC), counts summed over the corpora, words in fewer than {MIN_CORPORA}",
        f"# of them dropped, blocked words removed, counts scaled to 0-255, cut to the {KEEP:,} most frequent.",
    ]
    return header, [(w, frequency[w]) for w in kept]


SOURCES = {"aosp": aosp, "leipzig": leipzig}


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] not in SOURCES:
        print(__doc__, file=sys.stderr)
        return 2
    header, entries = SOURCES[argv[0]](*argv[1:])
    print("\n".join(header))
    for word, freq in entries:
        print(f"{word}\t{freq}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
