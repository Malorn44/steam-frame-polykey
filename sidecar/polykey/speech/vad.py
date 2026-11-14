"""Phrase detection on 16 kHz mono s16 audio: an energy gate over 20 ms frames with an adaptive noise
floor, and a voicing check. It counts frames, not wall-clock time, so tests feed it synthetic audio.

The thresholds follow TaiKeid's measurements on the Frame (Full Keyboard, docs/dictation.md, "Phrase
detection"): 0.3 s of pre-roll, an end after 0.6 s of quiet, at most 25 s per phrase. The floor is
the quietest frame of the last 2 s, so steady noise stops counting as speech; a phrase is checked
against the floor again when it ends, so noise at the very start is dropped rather than sent. The
Frame's microphone sends exact zeros while its noise gate is closed (and all the time off the head),
so zero frames are silence but never count towards the floor.

Loud is not enough: speech is also voiced, repeating itself at a voice's pitch (60–400 Hz), and it
goes on. Typing, clicks and hiss are loud for a frame or two but not periodic; a knock rings, but dies
away. So a phrase opens on a run of voiced frames as long as a short vowel that does not fade, and
inside one only voiced frames that follow another count, so typing neither opens a phrase nor keeps
one going. It ends 0.6 s after the voice; the unvoiced sounds of speech (s, f, t) are in the pre-roll
and tail. Whispering is not voiced, so it is not heard.
"""

from __future__ import annotations

import math
import operator
import sys
from array import array
from collections import deque
from typing import Optional

RATE = 16000
FRAME_SAMPLES = 320  # 20 ms
FRAME_BYTES = FRAME_SAMPLES * 2
FRAMES_PER_SECOND = RATE // FRAME_SAMPLES
PRE_ROLL = 15  # frames kept from before the first speech frame (the start of a word is quiet, or not voiced)
START = 3  # voiced frames in a row that open a phrase (a short vowel; a tap or a buzz is shorter)
FADE_DB = 3.0  # and that do not fade by more than this: a voice holds, a knock's ring dies away
END = 30  # frames without speech that end it
TAIL = 15  # quiet frames kept after the last speech frame (a final s or t is not voiced)
MIN_SPEECH = 6  # a phrase with fewer speech frames (120 ms of voice) is a cough or a grunt
MAX_PHRASE = 25 * FRAMES_PER_SECOND
ZERO_DB = -120.0
FLOOR_START_DB = -60.0
FLOOR_MAX_DB = -40.0  # near-field speech is louder than this, so a long loud phrase never gates itself
MARGIN_DB = 10.0  # speech is this far above the floor
GATE_MIN_DB = -55.0  # and never quieter than this
FLOOR_WINDOW = 2 * FRAMES_PER_SECOND
FLOOR_MIN = FRAMES_PER_SECOND // 2  # non-zero frames needed before the floor replaces FLOOR_START_DB
VOICE_STEP = 4  # samples summed into one for the voicing check: 4 kHz is plenty for a voice's pitch
LAG_MIN = RATE // VOICE_STEP // 400  # 400 Hz
LAG_MAX = RATE // VOICE_STEP // 60  # 60 Hz
VOICED = 0.6  # voicing() of a voice; typing and hiss score below it


def samples_of(frame: bytes) -> array:
    samples = array("h", frame[: len(frame) - len(frame) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def level_db(frame: bytes) -> float:
    """RMS level of a frame in dB below full scale; ZERO_DB for digital silence."""
    return rms_db(samples_of(frame))


def rms_db(samples: array) -> float:
    if not samples:
        return ZERO_DB
    power = sum(s * s for s in samples) / len(samples)
    return ZERO_DB if power == 0 else max(ZERO_DB, 10 * math.log10(power / (32768.0 * 32768.0)))


def voicing(samples: array) -> float:
    """How closely a window of audio (two frames: 40 ms) repeats itself at a voice's pitch period:
    about 1 for a vowel or a steady tone, near 0 for hiss or a click. It is the best autocorrelation
    over those lags (corrected for the overlap's length) as a share of the whole window's energy, so a
    sound that dies away within a pitch period scores low even if it rings."""
    x = [sum(group) for group in zip(*(samples[k::VOICE_STEP] for k in range(VOICE_STEP)))]
    n = len(x)
    if n <= LAG_MAX:
        return 0.0
    mean = sum(x) / n
    x = [v - mean for v in x]
    energy = sum(map(operator.mul, x, x))
    if energy <= 0:
        return 0.0
    best = max(sum(map(operator.mul, x, x[lag:])) * n / (n - lag) for lag in range(LAG_MIN, LAG_MAX + 1))
    return best / energy


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
        self._phrase_levels: list[float] = []  # the phrase's speech frames
        self._last = array("h")  # the frame before, for the voicing check's window
        self._voiced = False  # and whether it was loud and voiced
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
        samples = samples_of(frame)
        level = self.level = rms_db(samples)
        if level > ZERO_DB:
            self.all_zero = False
            self._levels.append(level)
        window, self._last = self._last + samples, samples
        voiced = level >= self.gate() and voicing(window) >= VOICED
        # In a phrase, a voice goes on from frame to frame; a key's thump that looks voiced is one frame.
        speech, self._voiced = voiced and self._voiced, voiced
        if self._phrase is None:
            if not voiced:
                self._preroll.extend(f for f, _ in self._run)
                self._run = []
                self._preroll.append(frame)
                return None
            self._run.append((frame, level))
            if len(self._run) < START or self._run[-1][1] < self._run[-START][1] - FADE_DB:
                return None
            self._phrase = bytearray(b"".join(self._preroll) + b"".join(f for f, _ in self._run))
            self._phrase_levels = [lv for _, lv in self._run]
            self._speech, self._quiet, self._keep = len(self._run), 0, len(self._phrase)
            self._preroll.clear()
            self._run = []
            return None
        self._phrase += frame
        if speech:
            self._phrase_levels.append(level)
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
