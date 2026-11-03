from __future__ import annotations

import asyncio
import io
import json

import pytest

from fake_cdp import FakeSteam, until
from fake_wayland import FakeCompositor
from polykey import desktop, injector
from polykey.bridge import BINDING_NAME, MAX_TEXT_CHARS, Bridge, reply_expression
from polykey.desktop import DesktopPaste
from polykey.injector import Config, Log

TEXT = "テスト"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(desktop, "SETTLE_SECONDS", 0.01)
    monkeypatch.setattr(desktop, "AFTER_PASTE_SECONDS", 0.01)


def focus(monkeypatch, process):
    async def fake_focused_process(display=":0"):
        return process
    monkeypatch.setattr(desktop, "focused_process", fake_focused_process)
    monkeypatch.setattr("polykey.bridge.focused_process", fake_focused_process)


def request(**fields) -> str:
    return json.dumps({"id": 7, **fields})


def test_rejects_bad_requests():
    async def main():
        bridge = Bridge(Log(io.StringIO()), None)
        assert await bridge.handle("not json") == {"id": None, "ok": False, "error": "bad-json"}
        assert await bridge.handle("[1]") == {"id": None, "ok": False, "error": "bad-request"}
        assert await bridge.handle(request(op="rm -rf")) == {"id": 7, "ok": False, "error": "unknown-op"}
        assert (await bridge.handle(request(op="desktop.prepare", text=TEXT)))["error"] == "desktop-paste-off"
    run(main())


def test_validates_text(tmp_path, monkeypatch):
    focus(monkeypatch, "kwin_wayland")

    async def main():
        bridge = Bridge(Log(io.StringIO()), DesktopPaste(tmp_path / "wayland-0"))
        for bad in ("", 5, None, "x" * (MAX_TEXT_CHARS + 1)):
            assert (await bridge.handle(request(op="desktop.prepare", text=bad)))["error"] == "bad-text"
    run(main())


def test_refuses_to_paste_outside_the_desktop(tmp_path, monkeypatch):
    focus(monkeypatch, "steam")

    async def main():
        fake = await FakeCompositor(tmp_path / "wayland-0").start()
        try:
            bridge = Bridge(Log(io.StringIO()), DesktopPaste(tmp_path / "wayland-0"))
            reply = await bridge.handle(request(op="desktop.prepare", text=TEXT))
            assert reply == {"id": 7, "ok": False, "error": "not-desktop", "process": "steam"}
            assert fake.owner["selection"] == ("app", "old clipboard")  # untouched
        finally:
            fake.stop()
    run(main())


def test_refuses_when_nothing_has_focus(tmp_path, monkeypatch):
    focus(monkeypatch, None)

    async def main():
        fake = await FakeCompositor(tmp_path / "wayland-0").start()
        try:
            bridge = Bridge(Log(io.StringIO()), DesktopPaste(tmp_path / "wayland-0"))
            reply = await bridge.handle(request(op="desktop.prepare", text=TEXT))
            assert reply == {"id": 7, "ok": False, "error": "focus-unknown", "process": ""}
            assert fake.owner["selection"] == ("app", "old clipboard")
        finally:
            fake.stop()
    run(main())


def test_prepare_and_wait_through_the_bridge(tmp_path, monkeypatch):
    focus(monkeypatch, "kwin_wayland")

    async def main():
        fake = await FakeCompositor(tmp_path / "wayland-0").start()
        out = io.StringIO()
        paste = DesktopPaste(tmp_path / "wayland-0")
        bridge = Bridge(Log(out), paste)
        try:
            assert await bridge.handle(request(op="desktop.prepare", text=TEXT)) == {"id": 7, "ok": True}
            assert await fake.paste("selection") == TEXT
            assert await bridge.handle(request(op="desktop.wait")) == {"id": 7, "ok": True, "pasted": True}
            assert await fake.paste("selection") == "old clipboard"
            assert TEXT not in out.getvalue()
        finally:
            paste.clipboard.close()
            fake.stop()
    run(main())


def test_desktop_missing_is_a_short_error(tmp_path, monkeypatch):
    focus(monkeypatch, "kwin_wayland")

    async def main():
        bridge = Bridge(Log(io.StringIO()), DesktopPaste(tmp_path / "nope"))
        reply = await bridge.handle(request(op="desktop.prepare", text=TEXT))
        assert reply == {"id": 7, "ok": False, "error": "no-desktop-socket"}
    run(main())


def test_reply_expression_is_safe_to_evaluate():
    expression = reply_expression({"id": 1, "ok": False, "error": "x');alert(1);//"})
    payload = expression.rsplit("bridgeReply(", 1)[1][:-1]
    assert json.loads(payload)["error"] == "x');alert(1);//"
    assert "\\u" in reply_expression({"id": 1, "process": "漢"})  # ASCII-only expression


def test_injector_registers_the_binding_and_answers_calls(tmp_path, monkeypatch):
    focus(monkeypatch, "kwin_wayland")

    async def main():
        steam = await FakeSteam().start()
        compositor = await FakeCompositor(tmp_path / "wayland-0").start()
        bundle = tmp_path / "bundle.js"
        bundle.write_text("/* bundle */", encoding="utf-8")
        out = io.StringIO()
        cfg = Config(devtools=steam.devtools, bundle=bundle, debounce=0.02, safety_check=0.3,
                     backoff_start=0.02, desktop_socket=tmp_path / "wayland-0")
        stop = asyncio.Event()
        task = asyncio.ensure_future(injector.run_service(cfg, Log(out), stop))
        try:
            await until(lambda: steam.injected)
            assert "Runtime.addBinding" in steam.methods
            await steam.call_binding(BINDING_NAME, json.dumps({"id": 3, "op": "desktop.prepare", "text": TEXT}))
            await until(lambda: len(steam.bridge_replies()) == 1)
            assert steam.bridge_replies()[0] == {"id": 3, "ok": True}
            assert await compositor.paste("selection") == TEXT
            await steam.call_binding(BINDING_NAME, json.dumps({"id": 4, "op": "desktop.wait"}))
            await until(lambda: len(steam.bridge_replies()) == 2)
            assert steam.bridge_replies()[1] == {"id": 4, "ok": True, "pasted": True}
            await steam.call_binding("someoneElsesBinding", "{}")
            await asyncio.sleep(0.1)
            assert len(steam.bridge_replies()) == 2
            assert TEXT not in out.getvalue()
            assert all(TEXT not in e for e in steam.evaluations if "bridgeReply" in e)
        finally:
            stop.set()
            await asyncio.wait_for(task, 3)
            compositor.stop()
            await steam.stop()
    run(main())


def test_stopping_the_service_restores_an_unfinished_paste(tmp_path, monkeypatch):
    focus(monkeypatch, "kwin_wayland")

    async def main():
        steam = await FakeSteam().start()
        compositor = await FakeCompositor(tmp_path / "wayland-0").start()
        bundle = tmp_path / "bundle.js"
        bundle.write_text("/* bundle */", encoding="utf-8")
        cfg = Config(devtools=steam.devtools, bundle=bundle, debounce=0.02, safety_check=0.3,
                     backoff_start=0.02, desktop_socket=tmp_path / "wayland-0")
        stop = asyncio.Event()
        task = asyncio.ensure_future(injector.run_service(cfg, Log(io.StringIO()), stop))
        try:
            await until(lambda: steam.injected)
            await steam.call_binding(BINDING_NAME, json.dumps({"id": 1, "op": "desktop.prepare", "text": TEXT}))
            await until(lambda: len(steam.bridge_replies()) == 1)
            stop.set()
            await asyncio.wait_for(task, 3)
            await asyncio.sleep(0.05)
            # Our connection is gone, so our selections are gone: the typed text is not left behind.
            # (Known limit: the restored old text went with it; Plasma's clipboard history keeps it.)
            assert compositor.owner["selection"] is None
            assert compositor.owner["primary"] is None
        finally:
            compositor.stop()
            await steam.stop()
    run(main())
