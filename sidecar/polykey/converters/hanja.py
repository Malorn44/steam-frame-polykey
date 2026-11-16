"""Hangul to Hanja (한자) with libhangul's dictionary, which SteamOS ships with ibus-hangul: the "hanja" converter.

The dictionary is /usr/share/libhangul/hanja/hanja.txt (BSD-3-Clause, (c) 2005, 2006 Choe Hwanjin, in its
own header), read where it is and never shipped: one `key:value:comment` line per Hanja, sorted by key
(bytewise), the comment a meaning for about 12,000 of them (韓: 나라 이름 한). Mapped, not loaded: each
lookup is a binary search over the file, so it takes no memory (a dict of the whole file would be 82 MB).

convert finds the words with Hanja in the reading (the word before the caret): from each place in it, the
longest word that starts there, leaving out one inside a longer one. It converts the longest, nearest the
caret of those as long, and cuts the reading around it: what goes before it, the word, whose candidates
carry their meanings as notes, and what follows it. With `lengths` (the cut as it was) and `resize`
(the word's segment, -1 or 1), it converts the word before or after that one instead. learn moves a picked Hanja to the front for its word, in ~/.local/share/polykey/hanja-learned.json
(capped), since the file's own order is not by use (한국 lists 寒國 before 韓國). Readings, picks and
the learned file are typed text: never logged.
"""

from __future__ import annotations

import json
import mmap
import os
from pathlib import Path
from typing import Optional

from .engine import ConverterUnavailable

DICTIONARY = Path("/usr/share/libhangul/hanja/hanja.txt")
# The most candidates one word shows (구 has 352).
MAX_CANDIDATES = 100
# Learned words kept, the least recently picked dropped first, and the Hanja kept for each.
MAX_LEARNED = 1000
MAX_LEARNED_EACH = 8


class HanjaUnavailable(ConverterUnavailable):
    pass


def learned_path() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "polykey" / "hanja-learned.json"


def _read_learned(path: Path) -> dict[str, list[str]]:
    """What was picked before, most recently picked word last; anything unreadable is left out."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        key: [value for value in values if isinstance(value, str)][:MAX_LEARNED_EACH]
        for key, values in list(data.items())[-MAX_LEARNED:]
        if isinstance(key, str) and isinstance(values, list)
    }


class Hanja:
    """The dictionary, mapped read-only, and the picks learned so far."""

    def __init__(self, dictionary: Path = DICTIONARY, learned: Optional[Path] = None) -> None:
        try:
            with open(dictionary, "rb") as file:
                self._map = mmap.mmap(file.fileno(), 0, access=mmap.ACCESS_READ)
        except (OSError, ValueError) as error:  # missing, unreadable or empty
            raise HanjaUnavailable("no hanja dictionary") from error
        # The data starts after the header's comments and blank lines.
        start = 0
        while start < len(self._map) and self._map[start : start + 1] in (b"#", b"\n"):
            end = self._map.find(b"\n", start)
            start = len(self._map) if end < 0 else end + 1
        self._start = start
        self._learned_path = learned if learned is not None else learned_path()
        self._learned = _read_learned(self._learned_path)

    def _first(self, target: bytes) -> int:
        """Where the first line whose key is not below `target` starts (the file's end if none)."""
        data, lo, hi = self._map, self._start, len(self._map)
        # lo is always a line's start.
        while lo < hi:
            mid = (lo + hi) // 2
            line = data.rfind(b"\n", lo, mid) + 1 or lo
            end = data.find(b"\n", line, hi)
            end = hi if end < 0 else end
            if data[line:end].split(b":", 1)[0] < target:
                lo = min(end + 1, hi)
            else:
                hi = line
        return lo

    def _begins(self, key: str) -> bool:
        """Whether a word in the dictionary starts with `key` (or is it)."""
        target = key.encode("utf-8")
        lo = self._first(target)
        return self._map[lo : lo + len(target)] == target

    def _entries(self, key: str) -> list[tuple[str, str]]:
        """The word's Hanja and their meanings ('' for none), in the file's order."""
        target = key.encode("utf-8")
        data, lo = self._map, self._first(target)
        found = []
        while lo < len(data):
            end = data.find(b"\n", lo)
            end = len(data) if end < 0 else end
            parts = data[lo:end].split(b":", 2)
            lo = end + 1
            if parts[0] != target:
                break
            try:
                value, note = parts[1].decode("utf-8"), parts[2].decode("utf-8").strip() if len(parts) > 2 else ""
            except (IndexError, UnicodeDecodeError):
                continue  # a malformed line
            if value:
                found.append((value, "" if note == key else note))
        return found

    def _candidates(self, key: str) -> tuple[list[str], list[str]]:
        """The word's Hanja, the ones picked before first, and their notes."""
        entries = self._entries(key)
        notes = dict(entries)
        learned = [value for value in self._learned.get(key, []) if value in notes]
        values = list(dict.fromkeys(learned + [value for value, _ in entries]))[:MAX_CANDIDATES]
        return values, [notes[value] for value in values]

    def spans(self, reading: str) -> list[tuple[int, int]]:
        """The words with Hanja in the reading, (start, end), in order: from each place, the longest that
        starts there, but not one inside a longer one (which starts before it and so comes first)."""
        found: list[tuple[int, int]] = []
        for start in range(len(reading)):
            end, longest = start + 1, None
            while end <= len(reading) and self._begins(reading[start:end]):
                if self._entries(reading[start:end]):
                    longest = end
                end += 1
            if longest is not None and not (found and found[-1][1] >= longest):
                found.append((start, longest))
        return found

    def convert(
        self, reading: str, lengths: Optional[list[int]] = None, resize: Optional[tuple[int, int]] = None
    ) -> list[dict]:
        """What goes before the word, the word with its Hanja, then what follows it (the others with no
        candidates); [] when no word in the reading has any."""
        spans = self.spans(reading)
        if not spans:
            return []
        # The longest; of those as long, the nearest the caret.
        span = max(spans, key=lambda s: (s[1] - s[0], s[1]))
        # The word before or after the one converted, by place: segment `resize[0]` of the cut `lengths`.
        if (
            resize
            and resize[1] in (-1, 1)
            and lengths
            and sum(lengths) == len(reading)
            and 0 <= resize[0] < len(lengths)
        ):
            start = sum(lengths[: resize[0]])
            was = (start, start + lengths[resize[0]])
            if was in spans:
                at = spans.index(was) + resize[1]
                span = spans[at] if 0 <= at < len(spans) else was
        start, end = span
        word = reading[start:end]
        candidates, notes = self._candidates(word)
        segment: dict = {"reading": word, "candidates": candidates}
        if any(notes):
            segment["notes"] = notes
        before = [{"reading": reading[:start], "candidates": []}] if start else []
        after = [{"reading": reading[end:], "candidates": []}] if end < len(reading) else []
        return before + [segment] + after

    def predict(self, reading: str) -> list[str]:
        return []

    def learn(self, reading: str, lengths: list[int], choices: list[int], texts: list[str]) -> bool:
        """A Hanja picked for the word `reading` comes first for it from now on."""
        if len(texts) != 1 or texts[0] not in dict(self._entries(reading)):
            return False
        picked = texts[0]
        before = self._learned.pop(reading, [])
        self._learned[reading] = [picked] + [value for value in before if value != picked][: MAX_LEARNED_EACH - 1]
        while len(self._learned) > MAX_LEARNED:
            del self._learned[next(iter(self._learned))]
        try:
            self._learned_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._learned_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self._learned, ensure_ascii=False) + "\n", encoding="utf-8")
            os.replace(tmp, self._learned_path)
        except OSError:
            pass  # kept for this run; the next pick tries again
        return True

    def learn_prediction(self, reading: str, text: str) -> bool:
        return False
