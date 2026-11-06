"""Phrase detection on 16 kHz mono s16 audio: an energy gate over 20 ms frames with an adaptive noise
floor. It counts frames, not wall-clock time, so tests feed it synthetic audio.

The thresholds follow TaiKeid's measurements on the Frame (Full Keyboard, docs/dictation.md, "Phrase
detection"): 0.3 s of pre-roll, an end after 0.6 s of quiet, at most 25 s per phrase. The floor is
the quietest frame of the last 2 s, so steady noise stops counting as speech; a phrase is checked
against the floor again when it ends, so noise at the very start is dropped rather than sent. The
Frame's microphone sends exact zeros while its noise gate is closed (and all the time off the head),
so zero frames are silence but never count towards the floor.
"""

from __future__ import annotations

import math
import sys
from array import array
from collections import deque
from typing import Optional

RATE = 16000
FRAME_SAMPLES = 320  # 20 ms
FRAME_BYTES = FRAME_SAMPLES * 2
FRAMES_PER_SECOND = RATE // FRAME_SAMPLES
PRE_ROLL = 15  # frames kept from before the first speech frame (the start of a word is quiet)
START = 2  # speech frames in a row that open a phrase
END = 30  # quiet frames that end it
TAIL = 10  # quiet frames kept after the last speech frame
MIN_SPEECH = 12  # a phrase with fewer speech frames is a click or a cough
MAX_PHRASE = 25 * FRAMES_PER_SECOND
ZERO_DB = -120.0
FLOOR_START_DB = -60.0
FLOOR_MAX_DB = -40.0  # near-field speech is louder than this, so a long loud phrase never gates itself
MARGIN_DB = 10.0  # speech is this far above the floor
GATE_MIN_DB = -55.0  # and never quieter than this
FLOOR_WINDOW = 2 * FRAMES_PER_SECOND
FLOOR_MIN = FRAMES_PER_SECOND // 2  # non-zero frames needed before the floor replaces FLOOR_START_DB


def level_db(frame: bytes) -> float:
    """RMS level of a frame in dB below full scale; ZERO_DB for digital silence."""
    samples = array("h", frame[: len(frame) - len(frame) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    if not samples:
        return ZERO_DB
    power = sum(s * s for s in samples) / len(samples)
    return ZERO_DB if power == 0 else max(ZERO_DB, 10 * math.log10(power / (32768.0 * 32768.0)))


class Segmenter:
    """Feed 20 ms frames; get back the audio of a phrase once it has ended."""

    def __init__(self) -> None:
        self._levels: deque[float] = deque(maxlen=FLOOR_WINDOW)  # recent non-zero frames
        self.frames = 0
        self.all_zero = True  # nothing but digital silence so far (headset off the head, or no mic)
        self._preroll: deque[bytes] = deque(maxlen=PRE_ROLL)
        self._run: list[tuple[bytes, float]] = []
        self._phrase: Optional[bytearray] = None
        self._speech = 0
        self._quiet = 0
        self._keep = 0
        self._phrase_levels: list[float] = []
        self.level = ZERO_DB  # the last frame's, for the mic key's bars

    @property
    def floor(self) -> float:
        return min(min(self._levels), FLOOR_MAX_DB) if len(self._levels) >= FLOOR_MIN else FLOOR_START_DB

    @property
    def in_phrase(self) -> bool:
        return self._phrase is not None

    def gate(self) -> float:
        return max(self.floor + MARGIN_DB, GATE_MIN_DB)

    def feed(self, frame: bytes) -> Optional[bytes]:
        self.frames += 1
        level = self.level = level_db(frame)
        if level > ZERO_DB:
            self.all_zero = False
            self._levels.append(level)
        speech = level >= self.gate()
        if self._phrase is None:
            if not speech:
                self._preroll.extend(f for f, _ in self._run)
                self._run = []
                self._preroll.append(frame)
                return None
            self._run.append((frame, level))
            if len(self._run) < START:
                return None
            self._phrase = bytearray(b"".join(self._preroll) + b"".join(f for f, _ in self._run))
            self._phrase_levels = [lv for _, lv in self._run]
            self._speech, self._quiet, self._keep = len(self._run), 0, len(self._phrase)
            self._preroll.clear()
            self._run = []
            return None
        self._phrase += frame
        self._phrase_levels.append(level)
        if speech:
            self._speech += 1
            self._quiet = 0
            self._keep = len(self._phrase)
        else:
            self._quiet += 1
        if self._quiet >= END or len(self._phrase) >= MAX_PHRASE * FRAME_BYTES:
            return self._end()
        return None

    def finish(self) -> Optional[bytes]:
        """The phrase so far (push to talk pressed again), if it has enough speech."""
        return self._end() if self._phrase is not None else None

    def _end(self) -> Optional[bytes]:
        phrase, speech, levels = self._phrase, self._speech, self._phrase_levels
        self._phrase, self._speech, self._quiet, self._phrase_levels = None, 0, 0, []
        # Speech against the floor as it is now: steady noise that opened the phrase no longer counts.
        gate = self.gate()
        if phrase is None or speech < MIN_SPEECH or sum(lv >= gate for lv in levels) < MIN_SPEECH:
            return None
        return bytes(phrase[: self._keep + TAIL * FRAME_BYTES])
