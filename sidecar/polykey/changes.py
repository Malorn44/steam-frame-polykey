"""The change counter a status long-poll follows (the updater's and the speech library's): every change
bumps `rev`, which wakes a request waiting with the `since` before it."""

from __future__ import annotations

import asyncio
import contextlib
from typing import Optional

MAX_WAIT = 20.0  # the longest a request waits for a change, in seconds


class Changes:
    def __init__(self) -> None:
        self.rev = 0
        self._changed: Optional[asyncio.Event] = None

    def bump(self) -> None:
        self.rev += 1
        if self._changed is not None:
            self._changed.set()
            self._changed = None

    async def wait(self, since: object, timeout_ms: object) -> None:
        """Until `rev` is not `since` any more, or the timeout (at most MAX_WAIT s)."""
        if not isinstance(since, int) or since != self.rev:
            return
        seconds = min(max(timeout_ms / 1000, 0), MAX_WAIT) if isinstance(timeout_ms, (int, float)) else MAX_WAIT
        if self._changed is None:
            self._changed = asyncio.Event()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._changed.wait(), seconds)
