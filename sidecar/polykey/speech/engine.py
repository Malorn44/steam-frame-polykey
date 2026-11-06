"""Speech to text with transcribe.cpp, in a helper process (worker.py) that keeps one model loaded
between phrases and is stopped after IDLE seconds unused, or when another model is wanted.

Phrases go to it over a pipe as raw PCM, never through a file; its text comes back the same way, and
nothing else of it reaches the journal (worker.py). It runs on the CPU only (GPU inference was
rejected: TaiKeid measured about 17 W and crashes) with at most THREADS threads.

The service unit caps the sidecar at MemoryHigh=96M and a loaded model needs far more, so the helper
runs in a transient systemd scope of its own when `systemd-run` is there, capped for its model.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Optional

from . import SpeechError
from .install import engine_dir
from .proc import spawn, stop
from .vad import RATE

IDLE = 60.0
START_TIMEOUT = 30.0
# A phrase's time limit: a floor plus a multiple of its length, room for a busy CPU without waiting long
# on a stuck helper.
REQUEST_TIMEOUT = 10.0
REQUEST_PER_SECOND = 2.0
THREADS = 4
WORKER = Path(__file__).with_name("worker.py")
LANGUAGE = re.compile(r"^[a-z]{2,3}$")
MAX_TEXT = 4096
# Whisper's notes for what is not speech: tags like [BLANK_AUDIO] and music notes anywhere, and a phrase
# that is only a parenthesised remark, such as "(music)" or "（拍手）".
TAGS = re.compile(r"\[[^\]]*\]|[♪♫]+")
REMARK = re.compile(r"^[(（][^)）]*[)）]$")


def scope(ram_mb: int) -> list[str]:
    """systemd-run for a helper with this model: memory for it and half a margin again, a low CPU weight."""
    limit = max(512, ram_mb * 3 // 2)
    return ["systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", f"MemoryMax={limit}M", "-p", "CPUWeight=50", "--"]


def clean(text: object) -> str:
    """The transcript without Whisper's annotations and extra spaces."""
    if not isinstance(text, str):
        return ""
    text = " ".join(TAGS.sub(" ", text).split())
    return "" if REMARK.match(text) else text[:MAX_TEXT]


class Engine:
    """The helper process: started on the first phrase, stopped after `idle` seconds without one."""

    def __init__(self, home: Path, version: str, log, idle: float = IDLE, use_scope: bool = True,
                 start_timeout: float = START_TIMEOUT, request_timeout: float = REQUEST_TIMEOUT,
                 request_per_second: float = REQUEST_PER_SECOND, python: str = sys.executable,
                 worker: Path = WORKER) -> None:
        self.directory = engine_dir(home, version)
        self._log = log
        self.idle = idle
        self._use_scope = use_scope
        self._start_timeout = start_timeout
        self._request_timeout = request_timeout
        self._request_per_second = request_per_second
        self._python = python
        self._worker = worker
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._model: Optional[Path] = None
        self._lock = asyncio.Lock()
        self._idle_task: Optional[asyncio.Task] = None

    @property
    def loaded(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def transcribe(self, pcm: bytes, language: str, model: Path, ram_mb: int) -> str:
        if not LANGUAGE.match(language):
            raise SpeechError("bad-language")
        async with self._lock:
            if self._idle_task is not None:
                self._idle_task.cancel()
            try:
                if self.loaded and self._model != model:
                    self._log.info("dictation: speech helper unloaded (another model)")
                    await self._stop()
                if not self.loaded:
                    await self._start(model, ram_mb)
                return await self._request(pcm, language)
            finally:
                self._idle_task = asyncio.ensure_future(self._unload_later())

    async def _request(self, pcm: bytes, language: str) -> str:
        proc = self._proc
        assert proc is not None and proc.stdin is not None and proc.stdout is not None
        limit = self._request_timeout + self._request_per_second * len(pcm) / 2 / RATE
        try:
            proc.stdin.write(json.dumps({"language": language, "bytes": len(pcm)}).encode() + b"\n")
            proc.stdin.write(pcm)
            await proc.stdin.drain()
            line = await asyncio.wait_for(proc.stdout.readline(), limit)
        except asyncio.TimeoutError:
            await self._stop()  # a stuck helper is not reused
            raise SpeechError("helper-timeout") from None
        except (OSError, ValueError):
            await self._stop()
            raise SpeechError("helper-failed") from None
        try:
            reply = json.loads(line) if line else None
        except ValueError:
            reply = None
        if not isinstance(reply, dict):  # it ended (a crash, or out of memory)
            await self._stop()
            raise SpeechError("helper-failed")
        if "error" in reply:
            raise SpeechError(str(reply["error"])[:32])
        return clean(reply.get("text"))

    async def _start(self, model: Path, ram_mb: int) -> None:
        if not (self.directory / "lib" / "libtranscribe.so").is_file():
            raise SpeechError("no-engine")
        if not model.is_file():
            raise SpeechError("no-model")
        prefix = scope(ram_mb) if self._use_scope and shutil.which("systemd-run") else []
        code = await self._launch(prefix, model)
        if code == "no-scope":
            # No user bus or no systemd-run: in the sidecar's own cgroup (its MemoryHigh then throttles it).
            self._log.info("dictation: no systemd scope for the speech helper; running it in the service")
            code = await self._launch([], model)
        if code:
            raise SpeechError(code)

    async def _launch(self, prefix: list[str], model: Path) -> Optional[str]:
        """Start the helper and wait for its model to load: None, or why not."""
        argv = [*prefix, self._python, "-I", "-B", str(self._worker), str(self.directory), str(model), str(THREADS)]
        loop = asyncio.get_running_loop()
        started = loop.time()
        try:
            self._proc = await spawn(*argv, stdin=True, stdout=True)
        except OSError:
            self._proc = None
            return "no-scope" if prefix else "helper-failed"
        assert self._proc.stdout is not None
        try:
            line = await asyncio.wait_for(self._proc.stdout.readline(), self._start_timeout)
            ready = json.loads(line) if line else None
        except (asyncio.TimeoutError, ValueError):
            ready = None
        if not isinstance(ready, dict) or ready.get("ready") is not True:
            await self._stop()
            if ready is None and prefix:
                return "no-scope"  # systemd-run itself failed, or the helper died at once
            return str(ready.get("error", "helper-failed"))[:32] if isinstance(ready, dict) else "helper-failed"
        self._model = model
        cpu = re.sub(r"[^A-Za-z0-9._-]", "", str(ready.get("cpu", "unknown")))[:32]
        self._log.info(f"dictation: speech helper loaded ({model.stem}, cpu {cpu}, {loop.time() - started:.1f} s)")
        return None

    async def _unload_later(self) -> None:
        await asyncio.sleep(self.idle)
        async with self._lock:
            if self.loaded:
                self._log.info("dictation: speech helper unloaded (idle)")
            await self._stop()

    async def _stop(self) -> None:
        proc, self._proc, self._model = self._proc, None, None
        if proc is not None and proc.stdin is not None:
            with contextlib.suppress(OSError, RuntimeError):
                proc.stdin.close()  # the helper ends when its input does
        await stop(proc, grace=2.0)

    async def unload(self) -> None:
        async with self._lock:
            await self._stop()

    async def unload_model(self, model: Path) -> None:
        """Stop the helper if it has `model` loaded (it is being deleted)."""
        async with self._lock:
            if self._model == model:
                await self._stop()

    async def close(self) -> None:
        if self._idle_task is not None:
            self._idle_task.cancel()
        await self._stop()
