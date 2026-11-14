#!/usr/bin/env python3
"""Build a word list for suggestions, packs/<ns>/words.tsv, from a source's word frequencies.

Usage:
  python3 scripts/make-lexicon.py aosp en_US_wordlist.combined.gz packs/en/blocked.sha256 > packs/en/words.tsv
  python3 -I scripts/make-lexicon.py leipzig --name Korean --letters '[가-힣]' --max-length 10 --min-corpora 2 \\
      --keep 60000 kor_news_2022_1M-words.txt kor-kr_web_2020_1M-words.txt kor_newscrawl_2016_1M-words.txt

aosp: AOSP LatinIME's word list (Apache-2.0), from
https://android.googlesource.com/platform/packages/inputmethods/LatinIME/+/refs/heads/main/dictionaries/.
Keeps the most frequent words (profanity included), drops blocked words and AOSP's not-a-word entries.

leipzig: the word lists (*-words.txt: id, word, count) of Leipzig Corpora Collection corpora in one
language (CC BY 4.0), from https://wortschatz.uni-leipzig.de/en/download. They are downloaded data: run
this with python3 -I. Words are taken in NFC, and kept whole: 1 to --max-length of --letters (a regular
expression for one letter), in at least --min-corpora of the corpora, their counts summed. Counts are
scaled to 0-255 as AOSP's are, and the --keep most frequent words kept. The header is built from the
arguments and the corpora's file names. DEVELOP.md has the command that builds packs/ko/words.tsv.
"""

from __future__ import annotations

import argparse
import gzip
import math
import re
import sys
import textwrap
import unicodedata
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
from polykey.lexicon import word_hash
from polykey.swipe import FREQUENCY_SCALE

KEEP = 60_000  # aosp: the most frequent words kept
HEADER = "# {name} word list for polykey suggestions: word<TAB>frequency (0-255), most frequent first."


def read_blocked(path: str) -> set[str]:
    return {line.strip() for line in Path(path).read_text(encoding="utf-8").splitlines() if not line.startswith("#")}


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
            if not m or "not_a_word=true" in m.group(4) or word_hash(m.group(1)) in blocked:
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


CORPUS = re.compile(r"([a-z]{3})(?:-[a-z]{2})?_([a-z]+)_(\d{4})_")


def corpus(path: str) -> tuple[str, str]:
    """kor_news_2022_1M-words.txt: ("kor", "news 2022"), its language's code at Leipzig and its name."""
    m = CORPUS.match(Path(path).name)
    if not m:
        raise SystemExit(f"{Path(path).name}: not a Leipzig corpus word list, like kor_news_2022_1M-words.txt")
    return m.group(1), f"{m.group(2)} {m.group(3)}"


def leipzig(
    name: str, letters: str, max_length: int, min_corpora: int, keep: int, sources: list[str]
) -> tuple[list[str], list[tuple[str, int]]]:
    whole = re.compile(f"(?:{letters}){{1,{max_length}}}")
    codes, names = zip(*map(corpus, sources))
    if len(set(codes)) > 1:
        raise SystemExit(f"corpora of more than one language: {', '.join(sorted(set(codes)))}")
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
                if whole.fullmatch(word):
                    mine[word] += int(parts[2])
        counts.update(mine)
        corpora.update(mine.keys())
    kept = sorted((w for w in counts if corpora[w] >= min_corpora), key=lambda w: (-counts[w], w))[:keep]
    frequency = scaled({w: counts[w] for w in kept})
    listed = f"{', '.join(names[:-1])} and {names[-1]} word lists" if len(names) > 1 else f"{names[0]} word list"
    notes = [
        f"Derived from the Leipzig Corpora Collection's {name} {listed}"
        f" (https://wortschatz.uni-leipzig.de/en/download/{codes[0]}), licensed CC BY 4.0; see LICENSE.words"
        " beside it.",
        f"Modified: only whole words of 1 to {max_length} letters {letters} (NFC), counts summed over the"
        f" corpora, words in fewer than {min_corpora} of them dropped, counts scaled to 0-255, cut to the"
        f" {keep:,} most frequent.",
    ]
    header = [HEADER.format(name=name), *(f"# {line}" for note in notes for line in textwrap.wrap(note, 104))]
    return header, [(w, frequency[w]) for w in kept]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sources = parser.add_subparsers(dest="source", required=True)
    aosp_args = sources.add_parser("aosp")
    aosp_args.add_argument("wordlist", help="en_US_wordlist.combined.gz")
    aosp_args.add_argument("blocked", help="packs/en/blocked.sha256")
    leipzig_args = sources.add_parser("leipzig")
    leipzig_args.add_argument("--name", required=True, help="the language, in English: Korean")
    leipzig_args.add_argument("--letters", required=True, help="a regular expression for one letter: [가-힣]")
    leipzig_args.add_argument("--max-length", type=int, required=True, help="the most letters a word kept has")
    leipzig_args.add_argument("--min-corpora", type=int, required=True, help="the fewest corpora a word kept is in")
    leipzig_args.add_argument("--keep", type=int, required=True, help="how many of the most frequent words to keep")
    leipzig_args.add_argument("corpora", nargs="+", help="each corpus's *-words.txt")
    args = parser.parse_args(argv)
    if args.source == "aosp":
        header, entries = aosp(args.wordlist, args.blocked)
    else:
        header, entries = leipzig(args.name, args.letters, args.max_length, args.min_corpora, args.keep, args.corpora)
    print("\n".join(header))
    for word, freq in entries:
        print(f"{word}\t{freq}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
