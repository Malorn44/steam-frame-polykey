"""Minimal stdlib Wayland client, enough for wlr-data-control.

Messages: object id (u32), size << 16 | opcode (u32), 4-byte-padded args. FDs arrive as SCM_RIGHTS
in order; handlers take them with take_fd().
"""

from __future__ import annotations

import array
import asyncio
import os
import socket
import struct
from pathlib import Path
from typing import Callable, Optional

DISPLAY_ID = 1
MAX_FDS_PER_READ = 28
ROUNDTRIP_TIMEOUT = 2.0


class WaylandError(Exception):
    """The compositor reported a protocol error, or the connection closed."""


def pack_uint(value: int) -> bytes:
    return struct.pack("=I", value)


def pack_string(value: Optional[str]) -> bytes:
    if value is None:
        return pack_uint(0)
    raw = value.encode("utf-8") + b"\0"
    return pack_uint(len(raw)) + raw + b"\0" * (-len(raw) % 4)


class Args:
    """Reads one message's arguments in order."""

    def __init__(self, body: bytes) -> None:
        self._body = body
        self._offset = 0

    def uint(self) -> int:
        (value,) = struct.unpack_from("=I", self._body, self._offset)
        self._offset += 4
        return value

    def string(self) -> Optional[str]:
        length = self.uint()
        if length == 0:
            return None
        raw = self._body[self._offset : self._offset + length - 1]
        self._offset += (length + 3) & ~3
        return raw.decode("utf-8", "replace")


Handler = Callable[[int, Args], None]


class Connection:
    """One client connection. Call start() inside a running event loop before sending."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._next_id = 2
        self._handlers: dict[int, Handler] = {DISPLAY_ID: self._on_display}
        self._buffer = b""
        self._fds: list[int] = []
        self._closed: Optional[asyncio.Future] = None
        self.error: Optional[str] = None

    @classmethod
    def connect(cls, path: Path) -> "Connection":
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(2)
        try:
            sock.connect(str(path))
        except OSError:
            sock.close()
            raise
        sock.settimeout(None)
        return cls(sock)

    @property
    def closed(self) -> bool:
        return self._closed is not None and self._closed.done()

    def start(self) -> None:
        loop = asyncio.get_running_loop()
        self._closed = loop.create_future()
        loop.add_reader(self._sock.fileno(), self._on_readable)

    def close(self) -> None:
        if self._closed is not None and not self._closed.done():
            self._closed.set_result(None)
        try:
            asyncio.get_running_loop().remove_reader(self._sock.fileno())
        except (RuntimeError, ValueError, OSError):
            pass
        self._sock.close()
        for fd in self._fds:
            os.close(fd)
        self._fds.clear()

    # --- objects -------------------------------------------------------------------------------

    def new_id(self, handler: Optional[Handler] = None) -> int:
        object_id = self._next_id
        self._next_id += 1
        if handler is not None:
            self._handlers[object_id] = handler
        return object_id

    def on(self, object_id: int, handler: Handler) -> None:
        self._handlers[object_id] = handler

    def forget(self, object_id: int) -> None:
        self._handlers.pop(object_id, None)

    def take_fd(self) -> int:
        """The next file descriptor that arrived with an event (call once per fd argument)."""
        if not self._fds:
            raise WaylandError("expected a file descriptor")
        return self._fds.pop(0)

    # --- requests ------------------------------------------------------------------------------

    def send(self, object_id: int, opcode: int, payload: bytes = b"", fds: tuple = ()) -> None:
        if self.closed:
            raise WaylandError(self.error or "connection closed")
        message = struct.pack("=II", object_id, ((8 + len(payload)) << 16) | opcode) + payload
        ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", fds))] if fds else []
        try:
            self._sock.sendmsg([message], ancillary)
        except OSError as error:
            self._shutdown(f"send failed ({type(error).__name__})")
            raise WaylandError(self.error) from error

    async def roundtrip(self) -> None:
        """Wait until the compositor has handled every request sent so far."""
        future = asyncio.get_running_loop().create_future()

        def done(_opcode: int, _args: Args) -> None:
            if not future.done():
                future.set_result(None)

        callback = self.new_id(done)
        self.send(DISPLAY_ID, 0, pack_uint(callback))  # wl_display.sync
        waiters = {future} if self._closed is None else {future, self._closed}
        try:
            finished, _ = await asyncio.wait(waiters, timeout=ROUNDTRIP_TIMEOUT, return_when=asyncio.FIRST_COMPLETED)
        finally:
            self.forget(callback)
        if self.closed:
            raise WaylandError(self.error or "connection closed")
        if future not in finished:
            raise WaylandError("compositor did not answer")

    async def registry(self) -> tuple[int, dict[str, tuple[int, int]]]:
        """Get the registry and the globals: interface -> (name, version)."""
        found: dict[str, tuple[int, int]] = {}

        def on_global(opcode: int, args: Args) -> None:
            if opcode == 0:  # wl_registry.global(name, interface, version)
                name = args.uint()
                interface = args.string() or ""
                found[interface] = (name, args.uint())

        registry = self.new_id(on_global)
        self.send(DISPLAY_ID, 1, pack_uint(registry))  # wl_display.get_registry
        await self.roundtrip()
        return registry, found

    def bind(self, registry: int, name: int, interface: str, version: int, handler: Optional[Handler] = None) -> int:
        object_id = self.new_id(handler)
        self.send(registry, 0, pack_uint(name) + pack_string(interface) + pack_uint(version) + pack_uint(object_id))
        return object_id

    # --- events --------------------------------------------------------------------------------

    def _on_display(self, opcode: int, args: Args) -> None:
        if opcode == 0:  # error(object, code, message)
            args.uint()
            code = args.uint()
            self._shutdown(f"protocol error {code}: {args.string()}")
        elif opcode == 1:  # delete_id(id)
            self.forget(args.uint())

    def _shutdown(self, reason: str) -> None:
        if self.error is None:
            self.error = reason
        if self._closed is not None and not self._closed.done():
            self._closed.set_result(None)
        try:
            asyncio.get_running_loop().remove_reader(self._sock.fileno())
        except (RuntimeError, ValueError, OSError):
            pass

    def _on_readable(self) -> None:
        try:
            data, ancillary, _flags, _addr = self._sock.recvmsg(65536, socket.CMSG_SPACE(MAX_FDS_PER_READ * 4))
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            data, ancillary = b"", []
        for level, kind, cdata in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                fds = array.array("i")
                fds.frombytes(cdata[: len(cdata) - len(cdata) % fds.itemsize])
                self._fds.extend(fds)
        if not data:
            self._shutdown("compositor closed the connection")
            return
        self._buffer += data
        while len(self._buffer) >= 8:
            object_id, size_opcode = struct.unpack_from("=II", self._buffer, 0)
            size, opcode = size_opcode >> 16, size_opcode & 0xFFFF
            if size < 8:
                self._shutdown("malformed message")
                return
            if len(self._buffer) < size:
                break
            body = self._buffer[8:size]
            self._buffer = self._buffer[size:]
            handler = self._handlers.get(object_id)
            if handler is None:
                continue
            try:
                handler(opcode, Args(body))
            except Exception:  # a handler bug must not stop the reader
                pass
