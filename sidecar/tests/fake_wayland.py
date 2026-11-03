"""A fake compositor with wl_seat and zwlr_data_control_manager_v1, for tests.

It models one data-control client, the clipboard and primary selection (initially owned by another
app with known text), offers for the current selections, and an app pasting (paste()).
"""
from __future__ import annotations

import array
import asyncio
import os
import socket
import struct
from pathlib import Path
from typing import Optional

SERVER_IDS = 0xFF000000


def _pack_string(value: str) -> bytes:
    raw = value.encode() + b"\0"
    return struct.pack("=I", len(raw)) + raw + b"\0" * (-len(raw) % 4)


class _Args:
    def __init__(self, body: bytes) -> None:
        self.body, self.off = body, 0

    def uint(self) -> int:
        (v,) = struct.unpack_from("=I", self.body, self.off)
        self.off += 4
        return v

    def string(self) -> str:
        n = self.uint()
        raw = self.body[self.off:self.off + n - 1]
        self.off += (n + 3) & ~3
        return raw.decode()


class FakeCompositor:
    def __init__(self, path: Path, *, data_control: bool = True, version: int = 2,
                 selection: Optional[str] = "old clipboard", primary: Optional[str] = "old primary") -> None:
        self.path = path
        self.data_control = data_control
        self.version = version
        # slot -> ("app", text) | ("client", source_id) | None
        self.owner: dict[str, Optional[tuple]] = {
            "selection": ("app", selection) if selection is not None else None,
            "primary": ("app", primary) if primary is not None else None,
        }
        self.kinds: dict[int, str] = {}
        self.source_mimes: dict[int, list[str]] = {}
        self.offers: dict[int, tuple] = {}  # offer id -> owner tuple
        self.device = 0
        self._next_server_id = SERVER_IDS
        self._listener: Optional[socket.socket] = None
        self._client: Optional[socket.socket] = None
        self._buffer = b""
        self._fds: list[int] = []

    async def start(self) -> "FakeCompositor":
        self._listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._listener.bind(str(self.path))
        self._listener.listen(1)
        self._listener.setblocking(False)
        asyncio.get_running_loop().add_reader(self._listener.fileno(), self._accept)
        return self

    def stop(self) -> None:
        loop = asyncio.get_running_loop()
        for sock in (self._client, self._listener):
            if sock is not None:
                try:
                    loop.remove_reader(sock.fileno())
                except (ValueError, OSError):
                    pass
                sock.close()
        for fd in self._fds:
            os.close(fd)

    def _accept(self) -> None:
        assert self._listener is not None
        client, _ = self._listener.accept()
        client.setblocking(True)
        self._client = client
        asyncio.get_running_loop().add_reader(client.fileno(), self._readable)

    # --- wire ----------------------------------------------------------------------------------

    def _event(self, obj: int, opcode: int, payload: bytes = b"", fd: Optional[int] = None) -> None:
        assert self._client is not None
        message = struct.pack("=II", obj, ((8 + len(payload)) << 16) | opcode) + payload
        ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd]))] if fd is not None else []
        self._client.sendmsg([message], ancillary)

    def _readable(self) -> None:
        assert self._client is not None
        data, ancillary, _, _ = self._client.recvmsg(65536, socket.CMSG_SPACE(28 * 4))
        for level, kind, cdata in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                fds = array.array("i")
                fds.frombytes(cdata[:len(cdata) - len(cdata) % fds.itemsize])
                self._fds.extend(fds)
        if not data:
            asyncio.get_running_loop().remove_reader(self._client.fileno())
            # Like a real compositor: a disconnected client's selections are gone.
            for slot, owner in self.owner.items():
                if owner and owner[0] == "client":
                    self.owner[slot] = None
            return
        self._buffer += data
        while len(self._buffer) >= 8:
            obj, so = struct.unpack_from("=II", self._buffer, 0)
            size, opcode = so >> 16, so & 0xFFFF
            if len(self._buffer) < size:
                break
            body, self._buffer = self._buffer[8:size], self._buffer[size:]
            self._request(obj, opcode, _Args(body))

    # --- requests ------------------------------------------------------------------------------

    def _request(self, obj: int, opcode: int, args: _Args) -> None:
        kind = "display" if obj == 1 else self.kinds.get(obj)
        if kind == "display" and opcode == 0:  # sync
            self._event(args.uint(), 0, struct.pack("=I", 0))
        elif kind == "display" and opcode == 1:  # get_registry
            registry = args.uint()
            self.kinds[registry] = "registry"
            globals_ = [(1, "wl_compositor", 6), (2, "wl_seat", 9)]
            if self.data_control:
                globals_.append((3, "zwlr_data_control_manager_v1", self.version))
            for name, interface, version in globals_:
                self._event(registry, 0, struct.pack("=I", name) + _pack_string(interface) + struct.pack("=I", version))
        elif kind == "registry" and opcode == 0:  # bind
            args.uint()
            interface = args.string()
            args.uint()
            self.kinds[args.uint()] = interface
        elif kind == "zwlr_data_control_manager_v1" and opcode == 0:  # create_data_source
            source = args.uint()
            self.kinds[source] = "source"
            self.source_mimes[source] = []
        elif kind == "zwlr_data_control_manager_v1" and opcode == 1:  # get_data_device
            self.device = args.uint()
            self.kinds[self.device] = "device"
            self._announce("selection")
            if self.version >= 2:
                self._announce("primary")
        elif kind == "source" and opcode == 0:  # offer
            self.source_mimes[obj].append(args.string())
        elif kind == "device" and opcode in (0, 2):  # set_selection / set_primary_selection
            slot = "selection" if opcode == 0 else "primary"
            source = args.uint()
            previous = self.owner[slot]
            self.owner[slot] = ("client", source) if source else None
            if previous and previous[0] == "client" and previous[1] != source \
                    and previous not in self.owner.values():
                self._event(previous[1], 1)  # cancelled
            self._announce(slot)
        elif kind == "offer" and opcode == 0:  # receive(mime, fd)
            mime = args.string()
            fd = self._fds.pop(0)
            owner = self.offers.get(obj)
            if owner and owner[0] == "client":
                self._event(owner[1], 0, _pack_string(mime), fd=fd)  # forward to the owning source
                os.close(fd)
            else:
                if owner and owner[1] is not None:
                    os.write(fd, owner[1].encode())
                os.close(fd)

    def _announce(self, slot: str) -> None:
        owner = self.owner[slot]
        if owner is None:
            self._event(self.device, 1 if slot == "selection" else 3, struct.pack("=I", 0))
            return
        offer = self._next_server_id
        self._next_server_id += 1
        self.kinds[offer] = "offer"
        self.offers[offer] = owner
        self._event(self.device, 0, struct.pack("=I", offer))  # data_offer
        mimes = ["text/plain;charset=utf-8", "text/plain"] if owner[0] == "app" else self.source_mimes[owner[1]]
        for mime in mimes:
            self._event(offer, 0, _pack_string(mime))
        self._event(self.device, 1 if slot == "selection" else 3, struct.pack("=I", offer))

    # --- test helpers --------------------------------------------------------------------------

    async def paste(self, slot: str = "selection", mime: str = "text/plain;charset=utf-8") -> Optional[str]:
        """An app pastes from a slot: returns the text it gets."""
        owner = self.owner[slot]
        if owner is None:
            return None
        if owner[0] == "app":
            return owner[1]
        read_fd, write_fd = os.pipe()
        self._event(owner[1], 0, _pack_string(mime), fd=write_fd)
        os.close(write_fd)
        loop = asyncio.get_running_loop()
        return (await loop.run_in_executor(None, _read_all, read_fd)).decode()

    def client_mimes(self, slot: str) -> list[str]:
        owner = self.owner[slot]
        return self.source_mimes[owner[1]] if owner and owner[0] == "client" else []


def _read_all(fd: int) -> bytes:
    chunks = []
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        chunks.append(chunk)
    os.close(fd)
    return b"".join(chunks)
