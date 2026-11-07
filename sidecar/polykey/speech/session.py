"""Dictation for the page, off unless settings.json says "dictation": true. Requests come over the
bridge (bridge.py routes `dictation.*` here):

  dictation.catalog             the models on offer (catalog.json, without where they come from)
  dictation.status {since?, timeoutMs?}
                                {enabled, rev, engine: {state, done?, total?, error?}, models: {id: same},
                                 choices}; with `since`, it answers once `rev` is not that any more
                                (download progress, a download ending, a delete) or on timeout
  dictation.download {model?}   fetch the engine (turning dictation on does that by itself) and, if
                                named, a model (only while dictation is on)
  dictation.delete {model}      delete a model, or stop its download
  dictation.start {language, continuous?}
                                start listening -> {session}; the model is the one chosen for the
                                language (settings.json "dictationModels"), else a downloaded one for it
  dictation.stop {session}      stop listening (the mic pressed again); what was said is recognized
  dictation.cancel              stop, and drop what was heard
  dictation.wait {session, phase, seq?, timeoutMs}
                                answers once the session's phase is not `phase` any more, or once there
                                is news past `seq` (a speech level, a recognized phrase; or on timeout):
                                {session, phase: listening|transcribing|done|error|cancelled, text?, error?,
                                 seq?, bars?, texts?, recognizing?}

A session takes one phrase: it ends after 0.6 s of quiet once speech has started, or with `no-speech`
when none starts. A continuous session takes phrase after phrase: each pause ends one, which is
recognized (in order, one at a time) while listening goes on, and its text handed out in `texts`. It
ends when stopped (the phrase under way is still recognized), on an error, or after IDLE_STOP without a
phrase starting (a forgotten mic); a phrase without words is dropped, and so is one that ends while
recognition is MAX_BEHIND behind. Text is handed out once, and dropped anyway after UNCLAIMED seconds.

Audio and text are never logged or written; the log gets codes and durations only. The bars are five
small numbers for the mic key, worked out from the frames already read; they are sent only while
speech is heard (and until they are flat again), so silence costs nothing.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections import deque
from pathlib import Path
from typing import Optional

from . import SpeechError
from .capture import Recorder, Tools
from .catalog import ANY, Catalog, Model, load as load_catalog
from .engine import Engine
from .library import MAX_WAIT, Library
from .vad import FRAMES_PER_SECOND, RATE, Segmenter

OPS = (
    "dictation.status",
    "dictation.catalog",
    "dictation.download",
    "dictation.delete",
    "dictation.start",
    "dictation.stop",
    "dictation.cancel",
    "dictation.wait",
)
NO_SPEECH = 8 * FRAMES_PER_SECOND  # listening this long without a phrase starting ends a session
IDLE_STOP = 60 * FRAMES_PER_SECOND  # a continuous session with no phrase started this long stops
MAX_BEHIND = 300 * RATE * 2  # audio waiting for recognition in a continuous session; past it a phrase is dropped
UNCLAIMED = 60.0
LANGUAGE = re.compile(r"^[a-z]{2,3}$")
BARS = 5
LEVEL_FRAMES = 4  # a level every 80 ms
LEVEL_MAX = 8
LEVEL_STEP_DB = 4.0


def data_dir() -> Path:
    """~/.local/share/polykey/speech: the engine in engine/, models in models/ (never in the repo)."""
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "polykey" / "speech"


def bar_level(level_db: float, gate_db: float) -> int:
    """0 below the speech gate, then a step per LEVEL_STEP_DB above it, up to LEVEL_MAX."""
    return 0 if level_db < gate_db else min(LEVEL_MAX, 1 + int((level_db - gate_db) / LEVEL_STEP_DB))


def pick(catalog: Catalog, language: str, choices: dict, ready: set) -> Optional[Model]:
    """The model for `language`: the one chosen for it, else a downloaded one made for it, else a
    downloaded one for any language (Whisper). Only downloaded models count."""
    chosen = catalog.model(choices.get(language))
    if chosen is not None and chosen.id in ready and chosen.serves(language):
        return chosen
    for fits in (lambda m: language in m.languages, lambda m: ANY in m.languages):
        found = next((m for m in catalog.models if m.id in ready and fits(m)), None)
        if found is not None:
            return found
    return None


class Dictation:
    def __init__(
        self,
        log,
        settings_path: Optional[Path],
        home: Optional[Path] = None,
        tools: Optional[Tools] = None,
        engine: Optional[Engine] = None,
        catalog: Optional[Catalog] = None,
        download_options: Optional[dict] = None,
    ) -> None:
        self._log = log
        self._settings_path = settings_path
        catalog = catalog or load_catalog()
        if catalog is None:
            log.info("dictation: catalog.json did not load; nothing can be downloaded")
        self.library = Library(home or data_dir(), catalog, log, download_options)
        self.tools = tools or Tools()
        self.engine = engine or Engine(self.library.home, catalog.engine.version if catalog else "0", log)
        self._session = 0
        self._phase = ""
        self._text: Optional[str] = None
        self._error: Optional[str] = None
        self._stopping = False
        self._task: Optional[asyncio.Task] = None
        self._drop: Optional[asyncio.TimerHandle] = None
        self._changed: Optional[asyncio.Event] = None
        self._bars: deque[int] = deque([0] * BARS, maxlen=BARS)
        self._seq = 0  # news for the page while a session runs: a level, a phrase's text, recognizing or not
        self._texts: list[str] = []  # a continuous session's recognized phrases, not yet handed out
        self._recognizing = False
        self._continuous = False

    # --- state shared with waiters ------------------------------------------------------------------

    def _touch(self) -> None:
        """Wake every dictation.wait."""
        if self._changed is not None:
            self._changed.set()
        self._changed = asyncio.Event()

    def _news(self) -> None:
        """Something for the page while the phase stays: wake dictation.wait past its seq."""
        self._seq += 1
        self._touch()

    def _set(self, phase: str, text: Optional[str] = None, error: Optional[str] = None) -> None:
        self._phase, self._text, self._error = phase, text, error
        self._touch()

    def _settings(self) -> dict:
        try:
            settings = json.loads(self._settings_path.read_text(encoding="utf-8")) if self._settings_path else {}
        except (OSError, ValueError):
            return {}
        return settings if isinstance(settings, dict) else {}

    def enabled(self) -> bool:
        return self._settings().get("dictation") is True

    def choices(self) -> dict:
        choices = self._settings().get("dictationModels")
        return (
            {k: v for k, v in choices.items() if isinstance(k, str) and isinstance(v, str)}
            if isinstance(choices, dict)
            else {}
        )

    # --- requests -----------------------------------------------------------------------------------

    async def handle(self, op: str, request: dict) -> dict:
        if op == "dictation.status":
            await self.library.wait(request.get("since"), request.get("timeoutMs"))
            return self.status()
        if op == "dictation.catalog":
            return self.library.page_catalog()
        if op == "dictation.wait":
            return await self._wait(request)
        if op == "dictation.cancel":
            await self.cancel()
            return {"ok": True}
        if op == "dictation.stop":
            if request.get("session") == self._session and self._phase == "listening":
                self._stopping = True
            return {"ok": True}
        if op == "dictation.delete":
            error = await self.library.delete(request.get("model"), self.engine.unload_model)
            return {"ok": False, "error": error} if error else self.status()
        if not self.enabled():
            return {"ok": False, "error": "off"}
        if self.library.catalog is None:
            return {"ok": False, "error": "no-catalog"}
        if op == "dictation.download":
            error = self.library.download(request.get("model"))
            return {"ok": False, "error": error} if error else self.status()
        return self._start(request.get("language"), request.get("continuous") is True)

    def status(self) -> dict:
        enabled = self.enabled()
        if enabled:
            self.library.fetch_missing_engine()
        return {"ok": True, "enabled": enabled, **self.library.status(), "choices": self.choices()}

    def startup(self) -> None:
        """The sidecar started: an engine that should be there but is not is fetched again."""
        if self.enabled():
            self.library.fetch_missing_engine()

    def _start(self, language: object, continuous: bool = False) -> dict:
        if not isinstance(language, str) or not LANGUAGE.match(language):
            return {"ok": False, "error": "bad-language"}
        if not self.library.engine_ready():
            self.library.fetch_missing_engine()  # it was deleted: fetch it again
            return {"ok": False, "error": "no-engine"}
        model = pick(self.library.catalog, language, self.choices(), self.library.ready())
        if model is None:
            return {"ok": False, "error": "no-model"}
        if self._phase in ("listening", "transcribing"):
            return {"ok": False, "error": "busy"}
        self._session += 1
        self._stopping = False
        if self._drop is not None:
            self._drop.cancel()
        self._bars.extend([0] * BARS)
        self._texts, self._recognizing, self._continuous = [], False, continuous
        self._set("listening")
        run = self._run_continuous if continuous else self._run
        self._task = asyncio.ensure_future(run(self._session, language, model))
        return {"ok": True, "session": self._session, "model": model.id}

    async def _wait(self, request: dict) -> dict:
        session, phase, timeout, seq = (
            request.get("session"),
            request.get("phase"),
            request.get("timeoutMs"),
            request.get("seq"),
        )
        seconds = min(max(timeout / 1000, 0), MAX_WAIT) if isinstance(timeout, (int, float)) else MAX_WAIT
        loop = asyncio.get_running_loop()
        deadline = loop.time() + seconds
        moved = lambda: isinstance(seq, int) and self._phase in ("listening", "transcribing") and self._seq != seq
        while session == self._session and phase == self._phase and not moved() and loop.time() < deadline:
            if self._changed is None:
                self._changed = asyncio.Event()
            try:
                await asyncio.wait_for(self._changed.wait(), deadline - loop.time())
            except asyncio.TimeoutError:
                break
        if session != self._session:
            return {"ok": True, "session": session, "phase": "cancelled"}
        out: dict = {"ok": True, "session": session, "phase": self._phase}
        if self._phase in ("listening", "transcribing"):
            out["seq"], out["recognizing"] = self._seq, self._recognizing
        if self._phase == "listening":
            out["bars"] = list(self._bars)
        if self._texts:
            out["texts"], self._texts = self._texts, []  # handed out once
        if self._phase == "done" and not self._continuous:
            out["text"], self._text = self._text or "", None  # handed out once
        if self._phase == "error":
            out["error"] = self._error
        return out

    async def cancel(self) -> None:
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if self._phase in ("listening", "transcribing", "done"):
            self._set("cancelled")

    def enable(self) -> None:
        """Dictation turned on: the engine download starts at once unless it is in place. Models are
        fetched when asked for."""
        self.library.enable()

    async def disable(self) -> None:
        """Dictation turned off: stop listening, stop every download, unload the helper."""
        await self.cancel()
        await self.library.stop()
        await self.engine.unload()

    async def close(self) -> None:
        await self.disable()
        await self.engine.close()

    # --- one session --------------------------------------------------------------------------------

    async def _run(self, session: int, language: str, model: Model) -> None:
        """One session. Every session logs how it ended (codes and durations only, never text)."""
        loop = asyncio.get_running_loop()
        name = f"dictation {session}"
        try:
            pcm = await self._listen(name)
            if session != self._session:
                self._log.info(f"{name}: superseded")
                return
            self._set("transcribing")
            started = loop.time()
            text = await self.engine.transcribe(pcm, language, self.library.model_path(model), model.ram_mb)
            heard = f"{len(pcm) / 2 / RATE:.1f} s of speech recognized in {loop.time() - started:.1f} s by {model.id}"
            del pcm
            if not text:
                self._log.info(f"{name}: no-speech ({heard}, no words)")
                self._set("error", error="no-speech")
                return
            self._log.info(f"{name}: done ({heard})")
            self._set("done", text=text)
            self._drop = loop.call_later(UNCLAIMED, self._forget, session)
        except SpeechError as error:
            self._log.info(f"{name}: {error.code}")
            self._set("error", error=error.code)
        except asyncio.CancelledError:
            self._log.info(f"{name}: cancelled while {self._phase or 'starting'}")
            raise
        except Exception as error:  # never let a session take the sidecar down
            self._log.info(f"{name}: failed ({type(error).__name__})")
            self._set("error", error="failed")

    def _show_level(self, peak_db: float, gate_db: float) -> None:
        """The next bar for the mic key; nothing once the bars are flat and it is still quiet."""
        level = bar_level(peak_db, gate_db)
        if level == 0 and not any(self._bars):
            return
        self._bars.append(level)
        self._news()

    def _meter(self, segmenter: Segmenter, peak: float, count: int) -> tuple[float, int]:
        """A bar for the mic key every LEVEL_FRAMES frames, from the loudest of them."""
        peak, count = max(peak, segmenter.level), count + 1
        if count < LEVEL_FRAMES:
            return peak, count
        self._show_level(peak, segmenter.gate())
        return -1e9, 0

    async def _listen(self, name: str) -> bytes:
        recorder = Recorder(self.tools)
        segmenter = Segmenter()
        pcm: Optional[bytes] = None
        peak, count = -1e9, 0
        await recorder.start()
        self._log.info(f"{name}: listening ({recorder.route})")
        try:
            while pcm is None:
                frame = None if self._stopping else await recorder.read()
                if frame is None:  # stopped, or the recorder ended
                    pcm = segmenter.finish()
                    break
                pcm = segmenter.feed(frame)
                peak, count = self._meter(segmenter, peak, count)
                if pcm is None and not segmenter.in_phrase and segmenter.frames >= NO_SPEECH:
                    # Only exact zeros: the headset is off the head (or the mic is muted).
                    raise SpeechError("mic-silent" if segmenter.all_zero else "no-speech")
        finally:
            await recorder.stop()
        if not pcm:
            raise SpeechError("no-speech")
        return pcm

    # --- a continuous session ------------------------------------------------------------------------

    async def _run_continuous(self, session: int, language: str, model: Model) -> None:
        """Listen and recognize at once: phrases queue for the one helper and are recognized in order."""
        name = f"dictation {session}"
        phrases: asyncio.Queue = asyncio.Queue()
        counts = {"done": 0, "dropped": 0, "waiting": 0}  # waiting: bytes queued for recognition
        listen = asyncio.ensure_future(self._listen_continuous(name, phrases, counts))
        recognize = asyncio.ensure_future(self._recognize_all(name, phrases, language, model, counts))
        tally = lambda: f"{counts['done']} phrases, {counts['dropped']} dropped"
        try:
            await asyncio.wait({listen, recognize}, return_when=asyncio.FIRST_COMPLETED)
            if recognize.done():  # it only ends early by failing
                listen.cancel()
                await asyncio.gather(listen, return_exceptions=True)
                recognize.result()
            outcome = listen.result()
            await phrases.put(None)
            if not recognize.done() and (self._recognizing or not phrases.empty()):
                self._set("transcribing")  # the last phrases are still on their way
            await recognize
            self._log.info(f"{name}: {outcome} ({tally()})")
            self._set("done")
            self._drop = asyncio.get_running_loop().call_later(UNCLAIMED, self._forget, session)
        except SpeechError as error:
            self._log.info(f"{name}: {error.code} ({tally()})")
            self._set("error", error=error.code)
        except asyncio.CancelledError:
            self._log.info(f"{name}: cancelled while {self._phase or 'starting'} ({tally()})")
            raise
        except Exception as error:  # never let a session take the sidecar down
            self._log.info(f"{name}: failed ({type(error).__name__})")
            self._set("error", error="failed")
        finally:
            for task in (listen, recognize):
                task.cancel()
            await asyncio.gather(listen, recognize, return_exceptions=True)
            self._recognizing = False

    def _queue(self, name: str, phrases: asyncio.Queue, counts: dict, pcm: bytes) -> None:
        """A phrase for recognition, unless recognition is already MAX_BEHIND behind."""
        if counts["waiting"] + len(pcm) > MAX_BEHIND:
            counts["dropped"] += 1
            self._log.info(f"{name}: a phrase dropped (recognition {counts['waiting'] / 2 / RATE:.0f} s behind)")
            return
        counts["waiting"] += len(pcm)
        phrases.put_nowait(pcm)

    async def _listen_continuous(self, name: str, phrases: asyncio.Queue, counts: dict) -> str:
        """Queue each phrase as it ends; how listening ended: `stopped` or `idle-stop`."""
        recorder = Recorder(self.tools)
        segmenter = Segmenter()
        peak, count, quiet = -1e9, 0, 0
        await recorder.start()
        self._log.info(f"{name}: listening continuously ({recorder.route})")
        try:
            while True:
                frame = None if self._stopping else await recorder.read()
                if frame is None:  # stopped, or the recorder ended: the phrase under way still counts
                    tail = segmenter.finish()
                    if tail:
                        self._queue(name, phrases, counts, tail)
                    return "stopped"
                pcm = segmenter.feed(frame)
                peak, count = self._meter(segmenter, peak, count)
                if pcm:
                    self._queue(name, phrases, counts, pcm)
                quiet = 0 if segmenter.in_phrase else quiet + 1
                if segmenter.all_zero and segmenter.frames >= NO_SPEECH:
                    raise SpeechError("mic-silent")  # the headset is off the head (or the mic is muted)
                if quiet >= IDLE_STOP:
                    return "idle-stop"
        finally:
            await recorder.stop()

    async def _recognize_all(
        self, name: str, phrases: asyncio.Queue, language: str, model: Model, counts: dict
    ) -> None:
        loop = asyncio.get_running_loop()
        number = 0
        while True:
            pcm = await phrases.get()
            if pcm is None:
                return
            counts["waiting"] -= len(pcm)
            number += 1
            self._recognizing = True
            self._news()
            started = loop.time()
            try:
                text = await self.engine.transcribe(pcm, language, self.library.model_path(model), model.ram_mb)
            finally:
                self._recognizing = False
            heard = f"{len(pcm) / 2 / RATE:.1f} s in {loop.time() - started:.1f} s by {model.id}"
            del pcm
            if text:
                counts["done"] += 1
                self._texts.append(text)
                self._log.info(f"{name}: phrase {number} done ({heard})")
            else:
                counts["dropped"] += 1
                self._log.info(f"{name}: phrase {number} dropped (no words; {heard})")
            self._news()

    def _forget(self, session: int) -> None:
        if session == self._session and self._phase == "done" and (self._text is not None or self._texts):
            self._text, self._texts = None, []
            self._log.info(f"dictation {session}: text not collected; dropped")
