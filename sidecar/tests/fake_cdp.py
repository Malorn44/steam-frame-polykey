"""A fake of Steam's debugger endpoint: /json plus one SharedJSContext websocket.

It models only what the injector relies on: whether window.__polykey exists, execution context
events, console messages, and Steam restarting (the target id changes and sockets close).
"""

from __future__ import annotations

import asyncio
import itertools
import json
import time

from aiohttp import web

from polykey import injector


class FakeSteam:
    def __init__(self) -> None:
        self._ids = itertools.count(1)
        self.target_id = f"T{next(self._ids)}"
        self.has_target = True
        self.injected = False
        self.page_version = "test"  # __polykey.version of the bundle "in the page"
        self.injects_version = "test"  # and of the one the sidecar injects
        self.keyboard = "hidden"  # what KEYBOARD_EXPRESSION says: open, hidden or unknown
        self.inject_count = 0
        self.uninstall_count = 0
        self.connections = 0
        self.evaluations: list[str] = []
        self.methods: list[str] = []
        self.sockets: set[web.WebSocketResponse] = set()
        self._runner: web.AppRunner | None = None
        self.port = 0

    @property
    def devtools(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def start(self) -> "FakeSteam":
        app = web.Application()
        app.router.add_get("/json", self._json)
        app.router.add_get("/devtools/page/{id}", self._ws)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        return self

    async def stop(self) -> None:
        for ws in list(self.sockets):
            await ws.close()
        if self._runner is not None:
            await self._runner.cleanup()

    async def _json(self, _request: web.Request) -> web.Response:
        targets = [
            {
                "type": "page",
                "title": "SteamVR - Keyboard",
                "id": "K1",
                "webSocketDebuggerUrl": f"ws://127.0.0.1:{self.port}/devtools/page/K1",
            }
        ]
        if self.has_target:
            targets.append(
                {
                    "type": "page",
                    "title": "SharedJSContext",
                    "id": self.target_id,
                    "webSocketDebuggerUrl": f"ws://127.0.0.1:{self.port}/devtools/page/{self.target_id}",
                }
            )
        return web.json_response(targets)

    async def _ws(self, request: web.Request) -> web.StreamResponse:
        if request.match_info["id"] != self.target_id:
            raise web.HTTPNotFound()
        ws = web.WebSocketResponse(max_msg_size=0)
        await ws.prepare(request)
        self.sockets.add(ws)
        self.connections += 1
        try:
            async for message in ws:
                await self._handle(ws, json.loads(message.data))
        finally:
            self.sockets.discard(ws)
        return ws

    async def _handle(self, ws: web.WebSocketResponse, data: dict) -> None:
        method, params = data["method"], data.get("params", {})
        self.methods.append(method)
        if method == "Runtime.evaluate":
            expression = params["expression"]
            self.evaluations.append(expression)
            await ws.send_json({"id": data["id"], "result": {"result": {"value": self._evaluate(expression)}}})
            return
        await ws.send_json({"id": data["id"], "result": {}})
        if method == "Runtime.enable":
            await self._send(ws, "Runtime.executionContextCreated", {"context": {"id": 1}})

    def _evaluate(self, expression: str) -> object:
        if expression == injector.CHECK_EXPRESSION:
            return self.page_version if self.injected else False
        if expression == injector.KEYBOARD_EXPRESSION:
            return self.keyboard
        if expression == injector.STATUS_EXPRESSION:
            return "test (running)" if self.injected else "missing"
        if expression == injector.UNINSTALL_EXPRESSION:
            was = self.injected
            self.injected = False
            self.uninstall_count += 1
            return was
        if f"//# sourceURL={injector.SOURCE_URL}" in expression:
            self.injected = True
            self.page_version = self.injects_version
            self.inject_count += 1
            return None
        if "__polykeyProbe" in expression:
            return json.dumps({"missing": [], "keyboardManagers": 1})
        return None

    @staticmethod
    async def _send(ws: web.WebSocketResponse, method: str, params: dict) -> None:
        await ws.send_json({"method": method, "params": params})

    async def reload(self) -> None:
        """The page reloaded in place: our global is gone and new contexts appear."""
        self.injected = False
        for ws in list(self.sockets):
            await self._send(ws, "Runtime.executionContextsCleared", {})
            await self._send(ws, "Runtime.executionContextCreated", {"context": {"id": 2}})

    async def restart(self) -> None:
        """Steam restarted: sockets close and the target comes back with a new id."""
        self.injected = False
        self.target_id = f"T{next(self._ids)}"
        for ws in list(self.sockets):
            await ws.close()

    async def call_binding(self, name: str, payload: str, context_id: int = 1) -> None:
        """The page called a CDP binding function."""
        for ws in list(self.sockets):
            await self._send(
                ws, "Runtime.bindingCalled", {"name": name, "payload": payload, "executionContextId": context_id}
            )

    def bridge_replies(self) -> list[dict]:
        """Replies the sidecar delivered through __polykey.bridgeReply(...)."""
        replies = []
        for expression in self.evaluations:
            if "bridgeReply(" in expression:
                replies.append(json.loads(expression.rsplit("bridgeReply(", 1)[1][:-1]))
        return replies

    async def console(self, *values: str, age_ms: float = 0, level: str = "log") -> None:
        params = {
            "type": level,
            "timestamp": time.time() * 1000 - age_ms,
            "args": [{"type": "string", "value": v} for v in values],
        }
        for ws in list(self.sockets):
            await self._send(ws, "Runtime.consoleAPICalled", params)


async def until(predicate, timeout: float = 3.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)
