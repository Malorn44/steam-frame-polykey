#!/usr/bin/env python3
"""Build packs/en/words.tsv from AOSP LatinIME's en_US word list (Apache-2.0).

Usage: python3 scripts/make-lexicon.py en_US_wordlist.combined.gz packs/en/blocked.sha256 > packs/en/words.tsv
Source: https://android.googlesource.com/platform/packages/inputmethods/LatinIME/+/refs/heads/main/dictionaries/
Keeps the most frequent words (profanity included), drops blocked words and AOSP's not-a-word entries.
"""
import gzip
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
from polykey.lexicon import word_hash  # noqa: E402

KEEP = 60_000
blocked = {line.strip() for line in Path(sys.argv[2]).read_text(encoding="utf-8").splitlines() if not line.startswith("#")}
entries = []
with gzip.open(sys.argv[1], "rt", encoding="utf-8") as source:
    for line in source:
        m = re.match(r" word=([^,]+),f=(\d+),flags=([^,]*)(.*)", line)
        if not m or "not_a_word=true" in m.group(4) or word_hash(m.group(1)) in blocked:
            continue
        entries.append((m.group(1), int(m.group(2))))
entries.sort(key=lambda e: -e[1])  # stable: AOSP order breaks ties
print("# English word list for polykey suggestions: word<TAB>frequency (0-255), most frequent first.")
print("# Derived from AOSP LatinIME dictionaries/en_US_wordlist.combined.gz (version 54, 2014):")
print("# Copyright (c) 2008, The Android Open Source Project. Licensed under the Apache License 2.0;")
print("# see packs/en/LICENSE.words. Modified: cut to the most frequent words, blocked words removed.")
for word, freq in entries[:KEEP]:
    print(f"{word}\t{freq}")
