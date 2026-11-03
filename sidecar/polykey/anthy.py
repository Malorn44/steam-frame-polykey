"""Kana-kanji conversion with libanthy, which SteamOS ships (/usr/lib/libanthy.so.0).

After frame-jp-keyboard's binding (MIT, injector/frame_jp_keyboard_injector.py). Every request is
self-contained: it carries the reading and the segment lengths, so the sidecar keeps no per-keystroke
state. Only `learn` writes: anthy's learning data in ~/.anthy (shared with ibus-anthy and fjk; the user
agreed, 2026-11-03), so picked candidates come first next time. Loaded on the first request. Readings
are typed text: never logged.
"""

from __future__ import annotations

import ctypes
from typing import Optional

LIBRARY = "libanthy.so.0"
UTF8_ENCODING = 2
UNCONVERTED = -1
MAX_CANDIDATES = 30
MAX_PREDICTIONS = 12
MAX_READING = 64
BUFFER_BYTES = 4096


class AnthyUnavailable(Exception):
    pass


class _ConvStat(ctypes.Structure):
    _fields_ = [("nr_segment", ctypes.c_int)]


class _SegmentStat(ctypes.Structure):
    _fields_ = [("nr_candidate", ctypes.c_int), ("seg_len", ctypes.c_int)]


class _PredictionStat(ctypes.Structure):
    _fields_ = [("nr_prediction", ctypes.c_int)]


class Anthy:
    """One anthy context in UTF-8 mode."""

    def __init__(self, library: str = LIBRARY) -> None:
        try:
            lib = ctypes.CDLL(library)
        except OSError as error:
            raise AnthyUnavailable("no libanthy") from error
        ctx = ctypes.c_void_p
        sig = {
            "anthy_init": ([], ctypes.c_int),
            "anthy_create_context": ([], ctx),
            "anthy_context_set_encoding": ([ctx, ctypes.c_int], ctypes.c_int),
            "anthy_set_string": ([ctx, ctypes.c_char_p], ctypes.c_int),
            "anthy_resize_segment": ([ctx, ctypes.c_int, ctypes.c_int], None),
            "anthy_get_stat": ([ctx, ctypes.POINTER(_ConvStat)], ctypes.c_int),
            "anthy_get_segment_stat": ([ctx, ctypes.c_int, ctypes.POINTER(_SegmentStat)], ctypes.c_int),
            "anthy_get_segment": ([ctx, ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int], ctypes.c_int),
            "anthy_set_prediction_string": ([ctx, ctypes.c_char_p], ctypes.c_int),
            "anthy_get_prediction_stat": ([ctx, ctypes.POINTER(_PredictionStat)], ctypes.c_int),
            "anthy_get_prediction": ([ctx, ctypes.c_int, ctypes.c_char_p, ctypes.c_int], ctypes.c_int),
            "anthy_commit_segment": ([ctx, ctypes.c_int, ctypes.c_int], ctypes.c_int),
            "anthy_commit_prediction": ([ctx, ctypes.c_int], ctypes.c_int),
        }
        for name, (args, result) in sig.items():
            function = getattr(lib, name)
            function.argtypes = args
            function.restype = result
        if lib.anthy_init() != 0:
            raise AnthyUnavailable("anthy_init failed")
        self._ctx = lib.anthy_create_context()
        if not self._ctx:
            raise AnthyUnavailable("anthy_create_context failed")
        lib.anthy_context_set_encoding(self._ctx, UTF8_ENCODING)
        self._lib = lib
        self._buffer = ctypes.create_string_buffer(BUFFER_BYTES)

    def _text(self, getter, *args) -> str:
        if getter(self._ctx, *args, self._buffer, BUFFER_BYTES) < 0:
            return ""
        return self._buffer.value.decode("utf-8", errors="replace")

    def _count(self) -> int:
        stat = _ConvStat()
        self._lib.anthy_get_stat(self._ctx, ctypes.byref(stat))
        return stat.nr_segment

    def _segment_stat(self, index: int) -> _SegmentStat:
        stat = _SegmentStat()
        self._lib.anthy_get_segment_stat(self._ctx, index, ctypes.byref(stat))
        return stat

    def convert(self, reading: str, lengths: Optional[list[int]] = None,
                resize: Optional[tuple[int, int]] = None) -> list[dict]:
        """Segments with candidates; with `lengths`, re-cut left to right first; then `resize` (index, ±1)."""
        if self._lib.anthy_set_string(self._ctx, reading.encode("utf-8")) != 0:
            return []
        if lengths and sum(lengths) == len(reading):
            for index, wanted in enumerate(lengths):
                if index >= self._count():
                    break
                have = self._segment_stat(index).seg_len
                if have != wanted:
                    self._lib.anthy_resize_segment(self._ctx, index, wanted - have)
        if resize and 0 <= resize[0] < self._count() and resize[1] in (-1, 1):
            self._lib.anthy_resize_segment(self._ctx, resize[0], resize[1])
        segments = []
        for index in range(self._count()):
            count = min(self._segment_stat(index).nr_candidate, MAX_CANDIDATES)
            segments.append({
                "reading": self._text(self._lib.anthy_get_segment, index, UNCONVERTED),
                "candidates": [self._text(self._lib.anthy_get_segment, index, n) for n in range(count)],
            })
        return segments

    def predict(self, reading: str) -> list[str]:
        if self._lib.anthy_set_prediction_string(self._ctx, reading.encode("utf-8")) != 0:
            return []
        stat = _PredictionStat()
        self._lib.anthy_get_prediction_stat(self._ctx, ctypes.byref(stat))
        return [self._text(self._lib.anthy_get_prediction, n) for n in range(min(stat.nr_prediction, MAX_PREDICTIONS))]


    def learn(self, reading: str, lengths: list[int], choices: list[int], texts: list[str]) -> bool:
        """Learn a sent conversion: re-create it, check every picked text, then commit each segment."""
        segments = self.convert(reading, lengths)
        if len(segments) != len(choices) or len(texts) != len(choices):
            return False
        for segment, choice, text in zip(segments, choices, texts):
            if not 0 <= choice < len(segment["candidates"]) or segment["candidates"][choice] != text:
                return False
        for index, choice in enumerate(choices):
            self._lib.anthy_commit_segment(self._ctx, index, choice)
        return True

    def learn_prediction(self, reading: str, text: str) -> bool:
        predictions = self.predict(reading)
        if text not in predictions:
            return False
        self._lib.anthy_commit_prediction(self._ctx, predictions.index(text))
        return True


class Converter:
    """Anthy, loaded on the first request; `unavailable` (not an exception) when it cannot load."""

    def __init__(self, factory=Anthy) -> None:
        self._factory = factory
        self._engine = None
        self._failed = False

    def _get(self):
        if self._engine is None and not self._failed:
            try:
                self._engine = self._factory()
            except AnthyUnavailable:
                self._failed = True
        return self._engine

    def handle(self, op: str, request: dict) -> dict:
        reading = request.get("reading")
        if not isinstance(reading, str) or not 0 < len(reading) <= MAX_READING:
            return {"ok": False, "error": "bad-reading"}
        engine = self._get()
        if engine is None:
            return {"ok": False, "error": "unavailable"}
        if op == "predict":
            return {"ok": True, "predictions": engine.predict(reading)}
        if op == "learn":
            prediction = request.get("prediction")
            if isinstance(prediction, str):
                return {"ok": engine.learn_prediction(reading, prediction)}
            lengths, choices, texts = request.get("lengths"), request.get("choices"), request.get("texts")
            if not (isinstance(lengths, list) and isinstance(choices, list) and isinstance(texts, list)
                    and all(isinstance(n, int) for n in lengths + choices) and all(isinstance(t, str) for t in texts)):
                return {"ok": False, "error": "bad-learn"}
            return {"ok": engine.learn(reading, lengths, choices, texts)}
        lengths = request.get("lengths")
        if lengths is not None and not (isinstance(lengths, list) and all(isinstance(n, int) and n > 0 for n in lengths)):
            return {"ok": False, "error": "bad-lengths"}
        resize = request.get("resize")
        if resize is not None and not (isinstance(resize, list) and len(resize) == 2 and all(isinstance(n, int) for n in resize)):
            return {"ok": False, "error": "bad-resize"}
        return {"ok": True, "segments": engine.convert(reading, lengths, tuple(resize) if resize else None)}
