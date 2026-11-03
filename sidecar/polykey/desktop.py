"""Typing into SteamOS Desktop Mode by pasting.

The nested kwin_wayland ignores gamescope's temporary keymap, so typed non-ASCII arrives as
number-row keys. Instead: prepare(text) saves the clipboard and primary selection and offers the
text on both (wlr-data-control, marked secret so Plasma's history skips it); the page presses a
paste chord; wait() reports whether an app fetched it and restores the saved text.
"""
from __future__ import annotations

import asyncio
import os
import re
import threading
from pathlib import Path
from typing import Optional

from .wayland import Args, Connection, WaylandError, pack_string, pack_uint

TEXT_MIMES = ("text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "TEXT", "STRING")
SECRET_HINT_MIME = "x-kde-passwordManagerHint"
MAX_TEXT_BYTES = 1 << 20
READ_TIMEOUT = 1.0
SETTLE_SECONDS = 0.1  # let clipboard managers look at a new selection before arming the paste
AFTER_PASTE_SECONDS = 0.3  # apps can fetch more than once
AUTO_RESTORE_SECONDS = 4.0  # if the page never calls wait()
NESTED_DESKTOP_PROCESS = "kwin_wayland"


class DesktopUnavailable(Exception):
    """The paste route cannot be used. `kind` is a short log-safe reason."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


def default_socket() -> Path:
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return Path(runtime) / "nested_plasma" / "wayland-0"


# --- which window has gamescope's focus ----------------------------------------------------------

_CARDINAL = re.compile(r"=\s*(\d+)")


def parse_cardinal(xprop_output: str) -> Optional[int]:
    """First number from `xprop` output such as "GAMESCOPE_FOCUSED_WINDOW(CARDINAL) = 77594624"."""
    match = _CARDINAL.search(xprop_output)
    return int(match.group(1)) if match else None


async def _xprop(args: list[str], display: str) -> str:
    env = {**os.environ, "DISPLAY": display}
    process = await asyncio.create_subprocess_exec(
        "xprop", *args, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(process.communicate(), 2)
    except asyncio.TimeoutError:
        process.kill()
        raise
    return out.decode("utf-8", "replace")


async def focused_process(display: str = ":0") -> Optional[str]:
    """Name of the process that owns gamescope's focused window, or None when unknown."""
    try:
        window = parse_cardinal(await _xprop(["-root", "GAMESCOPE_FOCUSED_WINDOW"], display))
        if not window:
            return None
        pid = parse_cardinal(await _xprop(["-id", str(window), "_NET_WM_PID"], display))
        if not pid:
            return None
        return Path(f"/proc/{pid}/comm").read_text(encoding="utf-8").strip() or None
    except (OSError, asyncio.TimeoutError, ValueError):
        return None


# --- the desktop clipboard -----------------------------------------------------------------------


class DataControl:
    """One wlr-data-control connection to the nested desktop."""

    def __init__(self, socket_path: Path) -> None:
        self._path = socket_path
        self._conn: Optional[Connection] = None
        self._manager = 0
        self._manager_version = 1
        self._device = 0
        self._offers: dict[int, set[str]] = {}
        self._current: dict[str, int] = {"selection": 0, "primary": 0}
        self._sources: dict[int, bytes] = {}
        self.text_served = asyncio.Event()

    @property
    def has_primary(self) -> bool:
        return self._manager_version >= 2

    async def ensure(self) -> None:
        if self._conn is not None and not self._conn.closed:
            return
        self.close()
        if not self._path.exists():
            raise DesktopUnavailable("no-desktop-socket")
        try:
            conn = Connection.connect(self._path)
        except OSError:
            raise DesktopUnavailable("desktop-connect-failed") from None
        conn.start()
        self._conn = conn
        try:
            registry, found = await conn.registry()
            if "zwlr_data_control_manager_v1" not in found or "wl_seat" not in found:
                raise DesktopUnavailable("no-data-control")
            seat_name, _ = found["wl_seat"]
            manager_name, manager_version = found["zwlr_data_control_manager_v1"]
            self._manager_version = min(manager_version, 2)
            seat = conn.bind(registry, seat_name, "wl_seat", 1)
            self._manager = conn.bind(registry, manager_name, "zwlr_data_control_manager_v1", self._manager_version)
            self._device = conn.new_id(self._on_device)
            conn.send(self._manager, 1, pack_uint(self._device) + pack_uint(seat))  # get_data_device
            await conn.roundtrip()  # the current selections arrive here
        except WaylandError:
            self.close()
            raise DesktopUnavailable("desktop-protocol-error") from None
        except DesktopUnavailable:
            self.close()
            raise

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
        self._conn = None
        self._offers.clear()
        self._sources.clear()
        self._current = {"selection": 0, "primary": 0}

    # Events on the data-control device.
    def _on_device(self, opcode: int, args: Args) -> None:
        if opcode == 0:  # data_offer(new_id offer)
            offer = args.uint()
            self._offers[offer] = set()

            def on_offer(op: int, offer_args: Args, offer_id: int = offer) -> None:
                if op == 0:  # offer(mime_type)
                    mime = offer_args.string()
                    if mime and offer_id in self._offers:
                        self._offers[offer_id].add(mime)
            assert self._conn is not None
            self._conn.on(offer, on_offer)
        elif opcode == 1:  # selection(offer or null)
            self._set_current("selection", args.uint())
        elif opcode == 3:  # primary_selection(offer or null)
            self._set_current("primary", args.uint())
        elif opcode == 2:  # finished
            self.close()

    def _set_current(self, slot: str, offer: int) -> None:
        previous = self._current.get(slot, 0)
        self._current[slot] = offer
        if previous and previous not in self._current.values():
            self._destroy_offer(previous)

    def _destroy_offer(self, offer: int) -> None:
        self._offers.pop(offer, None)
        if self._conn is not None and not self._conn.closed:
            self._conn.send(offer, 1)  # destroy
            self._conn.forget(offer)

    async def read(self, slot: str) -> Optional[str]:
        """The text currently in a slot ("selection" or "primary"), or None if it holds no text."""
        offer = self._current.get(slot, 0)
        mimes = self._offers.get(offer, set())
        mime = next((m for m in TEXT_MIMES if m in mimes), None)
        if not offer or mime is None or self._conn is None:
            return None
        read_fd, write_fd = os.pipe()
        try:
            self._conn.send(offer, 0, pack_string(mime), fds=(write_fd,))  # receive(mime, fd)
        finally:
            os.close(write_fd)
        try:
            data = await asyncio.wait_for(_read_all(read_fd), READ_TIMEOUT)
        except asyncio.TimeoutError:
            return None
        finally:
            os.close(read_fd)
        return data.decode("utf-8", "replace") if data is not None else None

    def _offer_source(self, data: bytes) -> int:
        assert self._conn is not None
        source = self._conn.new_id()
        self._conn.on(source, lambda op, args, source=source: self._on_source(source, op, args))
        self._conn.send(self._manager, 0, pack_uint(source))  # create_data_source
        for mime in TEXT_MIMES:
            self._conn.send(source, 0, pack_string(mime))  # offer
        self._conn.send(source, 0, pack_string(SECRET_HINT_MIME))
        self._sources[source] = data
        return source

    def _on_source(self, source: int, opcode: int, args: Args) -> None:
        assert self._conn is not None
        if opcode == 0:  # send(mime_type, fd)
            mime = args.string()
            fd = self._conn.take_fd()
            data = b"secret" if mime == SECRET_HINT_MIME else self._sources.get(source, b"")
            # On a thread, so read() of our own selection can't deadlock on a full pipe.
            threading.Thread(target=_write_and_close, args=(fd, data), daemon=True).start()
            if mime in TEXT_MIMES:
                self.text_served.set()
        elif opcode == 1:  # cancelled: someone else owns the slot now
            self._sources.pop(source, None)
            self._conn.send(source, 1)  # destroy
            self._conn.forget(source)

    async def put(self, slot: str, text: Optional[str]) -> None:
        """Offer `text` in a slot, or clear the slot when text is None."""
        assert self._conn is not None
        if slot == "primary" and not self.has_primary:
            return
        source = self._offer_source(text.encode("utf-8")) if text is not None else 0
        self._conn.send(self._device, 0 if slot == "selection" else 2, pack_uint(source))
        await self._conn.roundtrip()


def _write_and_close(fd: int, data: bytes) -> None:
    try:
        os.set_blocking(fd, True)
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
    except OSError:
        pass
    finally:
        os.close(fd)


async def _read_all(fd: int) -> Optional[bytes]:
    loop = asyncio.get_running_loop()
    os.set_blocking(fd, False)
    chunks: list[bytes] = []
    size = 0
    done = loop.create_future()

    def readable() -> None:
        nonlocal size
        try:
            chunk = os.read(fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            chunk = b""
        if chunk and size + len(chunk) <= MAX_TEXT_BYTES:
            chunks.append(chunk)
            size += len(chunk)
            return
        if not done.done():
            done.set_result(chunk == b"")  # EOF: complete; otherwise too big
    loop.add_reader(fd, readable)
    try:
        complete = await done
    finally:
        loop.remove_reader(fd)
    return b"".join(chunks) if complete else None


class DesktopPaste:
    """The paste route: prepare(text), the page presses the chord, then wait()."""

    def __init__(self, socket_path: Optional[Path] = None, display: str = ":0") -> None:
        self.clipboard = DataControl(socket_path or default_socket())
        self.display = display
        self._saved: Optional[dict[str, Optional[str]]] = None
        self._auto_restore: Optional[asyncio.TimerHandle] = None
        self._lock = asyncio.Lock()

    async def prepare(self, text: str) -> None:
        async with self._lock:
            await self._restore_locked()  # an unfinished paste is finished first
            await self.clipboard.ensure()
            saved = {"selection": await self.clipboard.read("selection"),
                     "primary": await self.clipboard.read("primary")}
            try:
                await self.clipboard.put("selection", text)
                await self.clipboard.put("primary", text)
            except WaylandError:
                self.clipboard.close()
                raise DesktopUnavailable("desktop-protocol-error") from None
            self._saved = saved
            await asyncio.sleep(SETTLE_SECONDS)
            self.clipboard.text_served.clear()
            loop = asyncio.get_running_loop()
            self._auto_restore = loop.call_later(AUTO_RESTORE_SECONDS, lambda: asyncio.ensure_future(self.restore()))

    async def wait(self, timeout: float = 2.0) -> bool:
        """True when an app fetched the text after prepare(). Restores the previous clipboard."""
        pasted = False
        if self._saved is not None:
            try:
                await asyncio.wait_for(self.clipboard.text_served.wait(), timeout)
                pasted = True
                await asyncio.sleep(AFTER_PASTE_SECONDS)
            except asyncio.TimeoutError:
                pass
        await self.restore()
        return pasted

    async def restore(self) -> None:
        async with self._lock:
            await self._restore_locked()

    async def _restore_locked(self) -> None:
        if self._auto_restore is not None:
            self._auto_restore.cancel()
            self._auto_restore = None
        saved, self._saved = self._saved, None
        if saved is None:
            return
        try:
            await self.clipboard.ensure()
            await self.clipboard.put("selection", saved["selection"])
            await self.clipboard.put("primary", saved["primary"])
        except (WaylandError, DesktopUnavailable):
            self.clipboard.close()  # closing drops our selection, so the text is gone either way
