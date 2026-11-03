"""Page -> sidecar requests over the CDP binding `polykeyBridge`; replies go to __polykey.bridgeReply.

Requests may carry typed text: never logged or echoed. Errors are short log-safe kinds.
"""
from __future__ import annotations

import json
from typing import Optional

from .desktop import NESTED_DESKTOP_PROCESS, DesktopPaste, DesktopUnavailable, focused_process
from .wayland import WaylandError

BINDING_NAME = "polykeyBridge"
REPLY_FUNCTION = "bridgeReply"
MAX_TEXT_CHARS = 4096
OPS = ("desktop.prepare", "desktop.wait")


def reply_expression(reply: dict) -> str:
    return (f"globalThis.__polykey && typeof globalThis.__polykey.{REPLY_FUNCTION} === 'function'"
            f" && globalThis.__polykey.{REPLY_FUNCTION}({json.dumps(reply, ensure_ascii=True)})")


class Bridge:
    def __init__(self, log, desktop: Optional[DesktopPaste] = None) -> None:
        self._log = log
        self._desktop = desktop

    async def handle(self, payload: str) -> dict:
        try:
            request = json.loads(payload)
        except (TypeError, ValueError):
            return {"id": None, "ok": False, "error": "bad-json"}
        if not isinstance(request, dict):
            return {"id": None, "ok": False, "error": "bad-request"}
        request_id = request.get("id") if isinstance(request.get("id"), int) else None
        op = request.get("op")
        if op not in OPS:
            return {"id": request_id, "ok": False, "error": "unknown-op"}
        try:
            result = await self._dispatch(op, request)
        except DesktopUnavailable as error:
            result = {"ok": False, "error": error.kind}
        except WaylandError:
            result = {"ok": False, "error": "desktop-protocol-error"}
        except Exception as error:  # never let a page request take the sidecar down
            self._log.info(f"bridge {op} failed: {type(error).__name__}")
            result = {"ok": False, "error": type(error).__name__}
        result["id"] = request_id
        return result

    async def _dispatch(self, op: str, request: dict) -> dict:
        if self._desktop is None:
            return {"ok": False, "error": "desktop-paste-off"}
        if op == "desktop.prepare":
            text = request.get("text")
            if not isinstance(text, str) or not text or len(text) > MAX_TEXT_CHARS:
                return {"ok": False, "error": "bad-text"}
            # Shift+Insert into anything else would paste whatever is on that app's clipboard.
            process = await focused_process(self._desktop.display)
            if process != NESTED_DESKTOP_PROCESS:
                return {"ok": False, "error": "not-desktop" if process else "focus-unknown",
                        "process": (process or "")[:32]}
            await self._desktop.prepare(text)
            return {"ok": True}
        # desktop.wait
        timeout = request.get("timeoutMs")
        seconds = min(max(timeout / 1000, 0), 5) if isinstance(timeout, (int, float)) else 2.0
        return {"ok": True, "pasted": await self._desktop.wait(seconds)}
