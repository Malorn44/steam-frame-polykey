"""The hangul speller: Hangul spelled as the keys a 2-set (두벌식) keyboard types it with, one compatibility
jamo a key (ㄱ, ㅏ). A syllable is its initial, vowel and final as Unicode decomposes it, each the letter
its key types: Unicode names the jamo alike (HANGUL CHOSEONG KIYEOK and HANGUL JONGSEONG KIYEOK are both
HANGUL LETTER KIYEOK, ㄱ). A compound vowel or final typed as two keys (the table's pairs: ㅘ is ㅗ then
ㅏ, ㄺ is ㄹ then ㄱ) is spelled as those two; one typed with Shift (ㄲ, ㅆ) is one key.

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
    """Spells Hangul with a hangul table (pack.schema.json's table `hangul`)."""

    def __init__(self, table: dict) -> None:
        pairs = [*table.get("compoundMedials", []), *table.get("compoundFinals", [])]
        self._split = {pair[2]: pair[:2] for pair in pairs if len(pair) == 3}
        self._keys: dict[str, Optional[str]] = {}  # by character, as spelled

    def _spell(self, ch: str) -> Optional[str]:
        letters = [_letter(jamo) for jamo in unicodedata.normalize("NFD", ch)]
        if not letters or None in letters:
            return None
        return "".join(self._split.get(letter, letter) for letter in letters)  # type: ignore[arg-type]

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
