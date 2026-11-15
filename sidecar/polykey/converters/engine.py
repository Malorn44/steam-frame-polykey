"""One converter behind the bridge ops convert, predict and learn: its engine is loaded on the first
request, and each request is checked before it reaches it. An engine turns a reading into segments
with candidates (convert), offers whole words for it (predict), and learns what was sent (learn,
learn_prediction). Readings are typed text: never logged.
"""

from __future__ import annotations

# The longest reading a converter is asked about (the page's composers keep to it too).
MAX_READING = 64


class ConverterUnavailable(Exception):
    """An engine says it cannot load (its library is missing). Any exception while loading counts the same."""


class Converter:
    """An engine, made by `factory` on the first request. If that fails, for any reason (its library or
    a dictionary missing), it is not tried again: every request gets `unavailable`, and the log says once
    which converter and the exception's type, nothing of the request.
    """

    def __init__(self, factory, name: str = "converter", log=None) -> None:
        self._factory = factory
        self._name = name
        self._log = log
        self._engine = None
        self._failed = False

    def _get(self):
        if self._engine is None and not self._failed:
            try:
                self._engine = self._factory()
            except Exception as error:  # whatever stops it loading, the page hears `unavailable`
                self._failed = True
                if self._log is not None:
                    self._log.info(f"{self._name} did not load: {type(error).__name__}")
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
            if not (
                isinstance(lengths, list)
                and isinstance(choices, list)
                and isinstance(texts, list)
                and all(isinstance(n, int) for n in lengths + choices)
                and all(isinstance(t, str) for t in texts)
            ):
                return {"ok": False, "error": "bad-learn"}
            return {"ok": engine.learn(reading, lengths, choices, texts)}
        lengths = request.get("lengths")
        if lengths is not None and not (
            isinstance(lengths, list) and all(isinstance(n, int) and n > 0 for n in lengths)
        ):
            return {"ok": False, "error": "bad-lengths"}
        resize = request.get("resize")
        if resize is not None and not (
            isinstance(resize, list) and len(resize) == 2 and all(isinstance(n, int) for n in resize)
        ):
            return {"ok": False, "error": "bad-resize"}
        return {"ok": True, "segments": engine.convert(reading, lengths, tuple(resize) if resize else None)}
