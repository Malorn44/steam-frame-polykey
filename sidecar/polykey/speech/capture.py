"""Microphone capture with pw-record, which writes raw 16 kHz mono s16 to its stdout: no audio library.

SteamOS links WirePlumber "smart" filters (echo cancellation, noise suppression) in front of the default
source, and their noise suppression mutes stretches of speech; TaiKeid found the raw microphone
transcribes far better (Full Keyboard, docs/dictation.md, "Voice filters", "Raw microphone"). WirePlumber
redirects streams aimed at the microphone to the filters, so we start pw-record unlinked and link it to
the microphone ourselves with pw-link, through the session manager's socket. Without that socket, one
clear microphone, or audio within STALL seconds, we record the default source instead.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from . import SpeechError
from .proc import run, spawn, stop
from .vad import FRAME_BYTES, RATE

AUDIO = ["--raw", "--rate", str(RATE), "--channels", "1", "--format", "s16"]
MANAGER_REMOTE = "pipewire-0-manager"
NODE_NAME = "polykey-dictation"
LINK_WAIT = 1.0  # for the recorder's input port to appear
STALL = 1.0  # a linked recorder that sends nothing in this long is replaced by the default source
READ_TIMEOUT = 2.0  # any recorder silent this long (not zeros: nothing at all) has failed


@dataclass
class Tools:
    """The PipeWire commands (tests pass fakes) and the runtime directory with PipeWire's sockets."""

    record: str = "pw-record"
    dump: str = "pw-dump"
    link: str = "pw-link"
    runtime_dir: Optional[str] = None

    def manager_socket(self) -> Optional[Path]:
        base = self.runtime_dir or os.environ.get("XDG_RUNTIME_DIR")
        path = Path(base) / MANAGER_REMOTE if base else None
        return path if path is not None and path.exists() else None


_RULE = re.compile(r'([\w.-]+)\s*[=:]\s*("(?:[^"\\]|\\.)*"|[^\s,}]+)')


def parse_rules(text: object) -> dict[str, str]:
    """An SPA-JSON object of plain values, as in `filter.smart.target = { media.class = "Audio/Source" }`."""
    if not isinstance(text, str):
        return {}
    body = text.strip()
    if not (body.startswith("{") and body.endswith("}")):
        return {}
    return {key: value[1:-1] if value.startswith('"') else value for key, value in _RULE.findall(body[1:-1])}


def _props(obj: dict) -> dict:
    info = obj.get("info")
    props = info.get("props") if isinstance(info, dict) else None
    return props if isinstance(props, dict) else {}


def raw_microphone(dump: object) -> Optional[tuple[str, list[str]]]:
    """From a pw-dump listing: the one device node the smart source filters target, as (node name,
    its output port names). None unless every filter agrees on exactly one device."""
    objects = [o for o in dump if isinstance(o, dict)] if isinstance(dump, list) else []
    nodes = [o for o in objects if o.get("type") == "PipeWire:Interface:Node"]
    targets = set()
    for node in nodes:
        props = _props(node)
        if props.get("media.class") != "Audio/Source" or str(props.get("filter.smart")).lower() != "true":
            continue
        rules = parse_rules(props.get("filter.smart.target"))
        if not rules:
            continue
        # The filters' own nodes share a link group; the device has none.
        found = [
            n
            for n in nodes
            if "node.link-group" not in _props(n) and all(str(_props(n).get(k)) == v for k, v in rules.items())
        ]
        if len(found) != 1:
            return None
        targets.add(found[0].get("id"))
    if len(targets) != 1:
        return None
    target = targets.pop()
    name = next((_props(n).get("node.name") for n in nodes if n.get("id") == target), None)
    ports = sorted(
        p["port.name"]
        for p in map(_props, (o for o in objects if o.get("type") == "PipeWire:Interface:Port"))
        if p.get("node.id") == target
        and p.get("port.direction") == "out"
        and str(p.get("port.monitor")).lower() != "true"
        and isinstance(p.get("port.name"), str)
    )
    return (name, ports) if isinstance(name, str) and ports else None


class Recorder:
    """One pw-record child; read() returns 20 ms frames until stop()."""

    def __init__(self, tools: Optional[Tools] = None) -> None:
        self.tools = tools or Tools()
        self.route = ""  # "mic" (raw microphone) or "default" (the default source), for the log
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._first: Optional[bytes] = None

    async def start(self) -> None:
        if await self._start_raw():
            self.route = "mic"
            return
        try:
            self._proc = await spawn(self.tools.record, *AUDIO, "-", stdout=True)
        except OSError:
            raise SpeechError("no-recorder") from None
        self.route = "default"

    async def _start_raw(self) -> bool:
        socket = self.tools.manager_socket()
        if socket is None:
            return False
        env = dict(os.environ, PIPEWIRE_REMOTE=MANAGER_REMOTE)
        code, out = await run(self.tools.dump, timeout=2.0, env=env)
        try:
            mic = raw_microphone(json.loads(out)) if code == 0 else None
        except ValueError:
            mic = None
        if mic is None:
            return False
        name, ports = mic
        node = f"{NODE_NAME}-{os.getpid()}"
        try:
            self._proc = await spawn(
                self.tools.record,
                *AUDIO,
                "-P",
                f"{{ node.autoconnect = false, node.name = {node} }}",
                "-",
                stdout=True,
                env=env,
            )
        except OSError:
            return False
        # Every channel into the one mono input; the links go away with the recorder.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + LINK_WAIT
        pending = list(ports)
        while pending and self._proc.returncode is None:
            code, _ = await run(self.tools.link, f"{name}:{pending[0]}", f"{node}:input_MONO", timeout=1.0, env=env)
            if code == 0:
                pending.pop(0)
            elif loop.time() > deadline:
                break
            else:
                await asyncio.sleep(0.05)  # its input port may not exist yet
        if not pending:
            try:
                self._first = await asyncio.wait_for(self._read(), STALL)
            except asyncio.TimeoutError:
                self._first = None
        if self._first is None:
            await self.stop()
            return False
        return True

    async def _read(self) -> Optional[bytes]:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            return await self._proc.stdout.readexactly(FRAME_BYTES)
        except asyncio.IncompleteReadError:
            return None

    async def read(self) -> Optional[bytes]:
        """The next frame; None once the recorder has ended."""
        if self._first is not None:
            frame, self._first = self._first, None
            return frame
        if self._proc is None:
            return None
        try:
            return await asyncio.wait_for(self._read(), READ_TIMEOUT)
        except asyncio.TimeoutError:
            raise SpeechError("no-microphone") from None

    async def stop(self) -> None:
        proc, self._proc = self._proc, None
        await stop(proc, grace=0.5)
