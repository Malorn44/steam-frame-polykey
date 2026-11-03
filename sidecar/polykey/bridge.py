"""Page -> sidecar requests over the CDP binding `polykeyBridge`; replies go to __polykey.bridgeReply.

Requests may carry typed text: never logged or echoed. Errors are short log-safe kinds.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from .anthy import Converter
from .desktop import NESTED_DESKTOP_PROCESS, DesktopPaste, DesktopUnavailable, focused_process
from .lexicon import Lexicons
from .packs import clean_emoji_state, clean_keyboard_options, save_settings, write_json
from .wayland import WaylandError

BINDING_NAME = "polykeyBridge"
REPLY_FUNCTION = "bridgeReply"
MAX_TEXT_CHARS = 4096
OPS = ("desktop.prepare", "desktop.wait", "suggest", "settings.save", "emoji.save", "convert", "predict", "learn")
MAX_SUGGESTIONS = 12


def reply_expression(reply: dict) -> str:
    return (f"globalThis.__polykey && typeof globalThis.__polykey.{REPLY_FUNCTION} === 'function'"
            f" && globalThis.__polykey.{REPLY_FUNCTION}({json.dumps(reply, ensure_ascii=True)})")


class Bridge:
    def __init__(self, log, desktop: Optional[DesktopPaste] = None, lexicons: Optional[Lexicons] = None,
                 settings_path: Optional[Path] = None, converter: Optional[Converter] = None) -> None:
        self._log = log
        self._converter = converter
        self._desktop = desktop
        self._lexicons = lexicons
        self._settings_path = settings_path

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
        if op == "suggest":
            return self._suggest(request)
        if op == "settings.save":
            return self._save_settings(request)
        if op == "emoji.save":
            return self._save_emoji(request)
        if op in ("convert", "predict", "learn"):
            return self._converter.handle(op, request) if self._converter else {"ok": False, "error": "unavailable"}
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

    def _save_settings(self, request: dict) -> dict:
        """Save the settings the page may change: theme id, haptics, suggestions, keyboard options."""
        changes = request.get("settings")
        if self._settings_path is None or not isinstance(changes, dict):
            return {"ok": False, "error": "bad-settings"}
        allowed = {"theme": str, "haptics": bool, "suggestions": bool, "keyboardOptions": dict}
        clean = {k: v for k, v in changes.items() if k in allowed and isinstance(v, allowed[k])}
        if "keyboardOptions" in clean:
            options = clean_keyboard_options(clean["keyboardOptions"])
            if options is None:
                return {"ok": False, "error": "bad-settings"}
            clean["keyboardOptions"] = options
        if not clean or len(clean) != len(changes) or len(str(clean.get("theme", ""))) > 80:
            return {"ok": False, "error": "bad-settings"}
        try:
            save_settings(self._settings_path, clean)
        except OSError as error:
            self._log.info(f"settings not saved: {type(error).__name__}")
            return {"ok": False, "error": "not-saved"}
        return {"ok": True}

    def _save_emoji(self, request: dict) -> dict:
        """Save recent and favorite emoji and the skin tone (typed content: never logged)."""
        if self._settings_path is None or not isinstance(request.get("state"), dict):
            return {"ok": False, "error": "bad-state"}
        try:
            write_json(self._settings_path.with_name("emoji.json"), clean_emoji_state(request["state"]))
        except OSError as error:
            self._log.info(f"emoji not saved: {type(error).__name__}")
            return {"ok": False, "error": "not-saved"}
        return {"ok": True}

    def _suggest(self, request: dict) -> dict:
        prefix, lexicon_id, limit = request.get("prefix"), request.get("lexicon"), request.get("limit", 3)
        if not isinstance(prefix, str) or not prefix or len(prefix) > 40:
            return {"ok": False, "error": "bad-prefix"}
        if not isinstance(limit, int) or not 1 <= limit <= MAX_SUGGESTIONS:
            return {"ok": False, "error": "bad-limit"}
        lexicon = self._lexicons.get(lexicon_id) if self._lexicons and isinstance(lexicon_id, str) else None
        if lexicon is None:
            return {"ok": False, "error": "no-lexicon"}
        return {"ok": True, "words": lexicon.suggest(prefix, limit)}
