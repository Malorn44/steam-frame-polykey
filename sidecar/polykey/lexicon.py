"""Word lists for suggestions: `packs/<ns>/<name>.tsv` with `word<TAB>count` per line (# comments).

Loaded on first use and kept in memory; a user list in ~/.config/polykey/packs/ replaces the bundled
one. Lookups are prefix completions ranked by count, and spelling corrections (`suggest`). Typed
prefixes are never logged.

Corrections follow frame-jp-keyboard's src/english.js (MIT, Copyright (c) 2026 sasaken1102r): words one
edit away, scored by how likely the slip is (a doubled letter, two swapped letters, a neighbouring
QWERTY key) and by frequency; two edits away when nothing is one away.

Blocked words (slurs; profanity is allowed) are never suggested, from any list: `<ns>/blocked.sha256`
holds SHA-256 hashes of normalized words, so the repo has no readable slur list; a user may add plain
words in `<ns>/blocked.txt`. Both are read from every pack folder and combined.
"""
from __future__ import annotations

import bisect
import hashlib
import heapq
import re
import unicodedata
from pathlib import Path
from types import MappingProxyType
from typing import Mapping, Optional

ID_PATTERN = re.compile(r"^[a-z0-9-]+/[a-z0-9-]+$")
MAX_WORD_CHARS = 40
MAX_BYTES = 8 << 20

LETTERS = "abcdefghijklmnopqrstuvwxyz'"
_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]


def _neighbours() -> dict[str, frozenset[str]]:
    out: dict[str, frozenset[str]] = {}
    for r, row in enumerate(_ROWS):
        for c, ch in enumerate(row):
            near = [row[c - 1] if c > 0 else "", row[c + 1] if c + 1 < len(row) else ""]
            if r > 0:
                near += [_ROWS[r - 1][c:c + 2]]
            if r + 1 < len(_ROWS):
                near += [_ROWS[r + 1][max(0, c - 1):c + 1]]
            out[ch] = frozenset("".join(near))
    return out


NEIGHBOURS = _neighbours()
# How likely each kind of slip is (lower: likelier), as in frame-jp-keyboard.
COST = {"double": 0.0, "transpose": 0.5, "neighbour": 1.0, "insert": 1.5, "delete": 1.5, "replace": 2.0}
# One cost unit is worth this much frequency (counts are 0-255, roughly logarithmic).
COST_WEIGHT = 32
# Few completions: look for corrections too.
FEW_COMPLETIONS = 3
MAX_CORRECTIONS = 3


def edits1(word: str) -> dict[str, float]:
    """Strings one edit away from word, each with the cost of its likeliest slip."""
    out: dict[str, float] = {}

    def put(candidate: str, cost: float) -> None:
        if candidate != word and cost < out.get(candidate, 99):
            out[candidate] = cost

    for i in range(len(word) + 1):
        left, right = word[:i], word[i:]
        if right:
            put(left + right[1:], COST["delete"])
        if len(right) > 1:
            put(left + right[1] + right[0] + right[2:], COST["transpose"])
        for c in LETTERS:
            if right:
                put(left + c + right[1:], COST["neighbour"] if c in NEIGHBOURS.get(right[0], ()) else COST["replace"])
            doubled = c == left[-1:] or c == right[:1]
            put(left + c + right, COST["double"] if doubled else COST["insert"])
    return out


def normalize(word: str) -> str:
    """The form blocked words are matched in: NFC, lower case, without a possessive 's."""
    word = unicodedata.normalize("NFC", word).lower()
    return re.sub(r"['’]s$", "", word)


def word_hash(word: str) -> str:
    return hashlib.sha256(normalize(word).encode("utf-8")).hexdigest()


class Lexicon:
    def __init__(self, counts: dict[str, int], blocked: frozenset[str] = frozenset()) -> None:
        self._counts = {w: c for w, c in counts.items() if word_hash(w) not in blocked} if blocked else counts
        self._keys = sorted(self._counts)
        # Lower case -> the most frequent spelling, for corrections.
        self._lower: dict[str, str] = {}
        for w in sorted(self._counts, key=lambda w: -self._counts[w]):
            self._lower.setdefault(w.lower(), w)

    @classmethod
    def parse(cls, text: str, blocked: frozenset[str] = frozenset()) -> "Lexicon":
        counts: dict[str, int] = {}
        for line in text.splitlines():
            if not line or line.startswith("#"):
                continue
            word, _, count = line.partition("\t")
            word = word.strip()
            if not word or len(word) > MAX_WORD_CHARS:
                continue
            try:
                value = int(count) if count else 1
            except ValueError:
                continue
            counts[word] = max(value, counts.get(word, 0))
        return cls(counts, blocked)

    def __len__(self) -> int:
        return len(self._keys)

    def counts(self) -> Mapping[str, int]:
        """Every word with its count (read-only), for engines that rank whole words (swipe)."""
        return MappingProxyType(self._counts)

    def complete(self, prefix: str, limit: int) -> list[str]:
        """The most frequent words starting with prefix (case-insensitive), most frequent first."""
        if not prefix:
            return []
        candidates: list[str] = []
        for variant in {prefix, prefix.lower(), prefix[:1].upper() + prefix[1:].lower()}:
            start = bisect.bisect_left(self._keys, variant)
            end = bisect.bisect_left(self._keys, variant + "\U0010ffff")
            candidates.extend(self._keys[start:end])
        return heapq.nlargest(limit, set(candidates), key=lambda w: (self._counts[w], w == w.lower()))

    def _corrections(self, typed: str) -> list[tuple[float, str]]:
        """(score, word) for words the typed one is probably a misspelling of; lower is likelier."""
        lower = typed.lower()
        if len(lower) < 2 or not all(c in LETTERS for c in lower):
            return []
        one = edits1(lower)
        scored = [(cost * COST_WEIGHT - self._counts[w], w)
                  for candidate, cost in one.items() if (w := self._lower.get(candidate))]
        if not scored and 3 <= len(lower) <= 10:
            seen: set[str] = set()
            for first in one:
                for candidate in edits1(first):
                    w = self._lower.get(candidate)
                    if w and candidate != lower and w not in seen:
                        seen.add(w)
                        scored.append((4 * COST_WEIGHT - self._counts[w], w))
        return sorted(scored)

    def correct(self, typed: str, limit: int = MAX_CORRECTIONS) -> list[str]:
        """Words the typed one is probably a misspelling of, likeliest first."""
        return [w for _, w in self._corrections(typed)[:limit]]

    def suggest(self, prefix: str, limit: int) -> list[str]:
        """Completions; with few of them, the likeliest corrections too, ranked together by score (a
        completion scores its frequency, a correction its frequency less the cost of the slip)."""
        words = self.complete(prefix, limit)
        if len(words) >= FEW_COMPLETIONS:
            return words
        scores = {w: float(-self._counts[w]) for w in words}
        known = {w.lower() for w in words} | {prefix.lower()}
        for score, w in self._corrections(prefix)[:MAX_CORRECTIONS]:
            if w.lower() not in known:
                scores[w] = score
        return sorted(scores, key=lambda w: scores[w])[:limit]


class Lexicons:
    """Lexicons by id, looked up in the user's packs first, then the bundled ones."""

    def __init__(self, dirs: list[Path]) -> None:
        self._dirs = dirs
        self._loaded: dict[str, Optional[Lexicon]] = {}

    def get(self, lexicon_id: str) -> Optional[Lexicon]:
        if not ID_PATTERN.match(lexicon_id):
            return None
        if lexicon_id not in self._loaded:
            self._loaded[lexicon_id] = self._load(lexicon_id)
        return self._loaded[lexicon_id]

    def _blocked(self, namespace: str) -> frozenset[str]:
        hashes: set[str] = set()
        for directory in self._dirs:
            try:
                text = (directory / namespace / "blocked.sha256").read_text(encoding="utf-8")
                hashes.update(h for h in (line.strip() for line in text.splitlines()) if re.fullmatch(r"[0-9a-f]{64}", h))
            except OSError:
                pass
            try:
                text = (directory / namespace / "blocked.txt").read_text(encoding="utf-8")
                hashes.update(word_hash(w) for w in (line.strip() for line in text.splitlines()) if w and not w.startswith("#"))
            except OSError:
                pass
        return frozenset(hashes)

    def _load(self, lexicon_id: str) -> Optional[Lexicon]:
        namespace, name = lexicon_id.split("/")
        for directory in self._dirs:
            path = directory / namespace / f"{name}.tsv"
            try:
                if path.stat().st_size > MAX_BYTES:
                    continue
                return Lexicon.parse(path.read_text(encoding="utf-8"), self._blocked(namespace))
            except OSError:
                continue
        return None
