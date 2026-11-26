"""The hangul-2set speller: Hangul spelled as the keys a 2-set (두벌식) keyboard types it with, one
compatibility jamo a key (ㄱ, ㅏ). A syllable is its initial, vowel and final as Unicode decomposes it,
each the letter its key types: Unicode names the jamo alike (HANGUL CHOSEONG KIYEOK and HANGUL JONGSEONG
KIYEOK are both HANGUL LETTER KIYEOK, ㄱ). A jamo the keyboard's table makes of two (its pairs: ㅘ is ㅗ
then ㅏ, ㄺ is ㄹ then ㄱ) is spelled as those two, each spelled again (a table where ㅑ is ㅏ ㅏ and ㅒ is
ㅑ ㅣ spells ㅒ ㅏㅏㅣ, and 천지인's ㅘ is its strokes ㆍㅡㅣㆍ); one typed with Shift (ㄲ, ㅆ) is one key.

So 한 is ㅎㅏㄴ, which starts both 한국 (ㅎㅏㄴㄱㅜㄱ) and 하나 (ㅎㅏㄴㅏ), as typing them does; matching
the syllables instead would miss 하나, whose ㄴ starts its second syllable.
"""

from __future__ import annotations

import unicodedata
from typing import Optional

JAMO_KINDS = ("CHOSEONG", "JUNGSEONG", "JONGSEONG", "LETTER")  # initial, vowel, final, a jamo alone


def _letter(jamo: str) -> Optional[str]:
    """A jamo (conjoining or not) as the letter a key types, or None for anything else."""
    kind, _, letter = unicodedata.name(jamo, "").removeprefix("HANGUL ").partition(" ")
    if kind not in JAMO_KINDS or not letter:
        return None
    try:
        return unicodedata.lookup(f"HANGUL LETTER {letter}")
    except KeyError:  # an old jamo no key types
        return None


class HangulSpeller:
    """Spells Hangul with the keyboard's hangul table (pack.schema.json's table `hangul`)."""

    def __init__(self, table: dict) -> None:
        pairs = [*table.get("compoundMedials", []), *table.get("compoundFinals", [])]
        self._split = {pair[2]: pair[:2] for pair in pairs if len(pair) == 3}
        self._keys: dict[str, Optional[str]] = {}  # by character, as spelled

    def _split_up(self, letter: str, depth: int = 0) -> str:
        pair = self._split.get(letter)
        return "".join(self._split_up(half, depth + 1) for half in pair) if pair and depth < 4 else letter

    def _spell(self, ch: str) -> Optional[str]:
        jamo = unicodedata.normalize("NFD", ch)
        letters = [part if part in self._split else _letter(part) for part in jamo]  # 천지인's ᆢ is ㆍㆍ
        if not letters or None in letters:
            return None
        return "".join(self._split_up(letter) for letter in letters)  # type: ignore[arg-type]

    def spell(self, text: str) -> Optional[str]:
        """The keys text is typed with, or None when any of it is not Hangul."""
        keys = []
        for ch in text:
            if ch not in self._keys:
                self._keys[ch] = self._spell(ch)
            spelled = self._keys[ch]
            if spelled is None:
                return None
            keys.append(spelled)
        return "".join(keys)
