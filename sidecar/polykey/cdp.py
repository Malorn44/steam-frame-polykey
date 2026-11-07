"""A minimal Chrome DevTools Protocol client over one websocket.

Request/response with timeouts, plus an event callback. Nothing here knows about polykey.
"""

from __future__ import annotations

import asyncio
import itertools
import json
from typing import Callable, Optional
from urllib.parse import urlsplit

import aiohttp

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

EventHandler = Callable[[str, dict], None]


class CdpError(Exception):
    """A CDP call failed, or the websocket closed while it was pending."""


def check_loopback(devtools: str) -> None:
    """Refuse any debugger endpoint that is not on this machine.

    Steam's debugger controls the whole Steam client, so polykey only ever talks to loopback.
    """
    host = urlsplit(devtools).hostname or ""
    if host not in LOOPBACK_HOSTS:
        raise ValueError(f"refusing non-loopback debugger endpoint {host!r}; use 127.0.0.1")


async def list_targets(http: aiohttp.ClientSession, devtools: str) -> list:
    async with http.get(f"{devtools}/json") as response:
        targets = await response.json(content_type=None)
    return targets if isinstance(targets, list) else []


def find_target(targets: list, title: str) -> Optional[dict]:
    return next(
        (t for t in targets if isinstance(t, dict) and t.get("title") == title and t.get("webSocketDebuggerUrl")), None
    )


class CdpSession:
    def __init__(
        self, ws: aiohttp.ClientWebSocketResponse, on_event: Optional[EventHandler] = None, call_timeout: float = 15.0
    ) -> None:
        self._ws = ws
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._on_event = on_event
        self._call_timeout = call_timeout
        self._reader = asyncio.ensure_future(self._read())

    @property
    def closed(self) -> bool:
        return self._reader.done()

    async def wait_closed(self) -> None:
        """Wait until the websocket closes. Cancelling this wait does not stop the reader."""
        await asyncio.wait({self._reader})

    async def _read(self) -> None:
        try:
            async for message in self._ws:
                if message.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(message.data)
                except ValueError:
                    continue
                if "id" in data:
                    future = self._pending.pop(data["id"], None)
                    if future is not None and not future.done():
                        future.set_result(data)
                elif "method" in data and self._on_event is not None:
                    try:
                        self._on_event(data["method"], data.get("params") or {})
                    except Exception:  # an event handler bug must not stop the reader
                        pass
        finally:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(CdpError("websocket closed"))
            self._pending.clear()

    async def call(self, method: str, params: Optional[dict] = None) -> dict:
        if self.closed:
            raise CdpError("websocket closed")
        message_id = next(self._ids)
        future = asyncio.get_running_loop().create_future()
        self._pending[message_id] = future
        try:
            await self._ws.send_json({"id": message_id, "method": method, "params": params or {}})
            reply = await asyncio.wait_for(future, self._call_timeout)
        finally:
            self._pending.pop(message_id, None)
        if "error" in reply:
            error = reply["error"]
            raise CdpError(f"{method}: {error.get('message', error) if isinstance(error, dict) else error}")
        return reply.get("result", {})

    async def evaluate(self, expression: str) -> object:
        """Evaluate in the target's default context and return the value (by value)."""
        result = await self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True})
        if "exceptionDetails" in result:
            details = result["exceptionDetails"]
            description = (details.get("exception") or {}).get("description") or details.get("text") or "exception"
            # First line only, length-capped: enough to diagnose, never a dump of page state.
            raise CdpError(str(description).splitlines()[0][:200])
        return (result.get("result") or {}).get("value")

    async def close(self) -> None:
        await self._ws.close()
        await self.wait_closed()
