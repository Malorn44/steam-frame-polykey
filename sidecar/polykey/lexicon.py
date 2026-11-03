"""Word lists for suggestions: `packs/<ns>/<name>.tsv` with `word<TAB>count` per line (# comments).

Loaded on first use and kept in memory; a user list in ~/.config/polykey/packs/ replaces the bundled
one. Lookups are prefix completions ranked by count. Typed prefixes are never logged.

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
from typing import Optional

ID_PATTERN = re.compile(r"^[a-z0-9-]+/[a-z0-9-]+$")
MAX_WORD_CHARS = 40
MAX_BYTES = 8 << 20


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
