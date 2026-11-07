from __future__ import annotations

import asyncio
import io
import json
import shutil
import subprocess
from pathlib import Path

import aiohttp
import pytest

from fake_cdp import FakeSteam, until
from polykey import injector
from polykey.cdp import check_loopback, find_target, list_targets
from polykey.injector import Config, Log


def fast_config(fake: FakeSteam, tmp_path: Path, **overrides) -> Config:
    bundle = tmp_path / "bundle.js"
    bundle.write_text("/* bundle */", encoding="utf-8")
    probe = tmp_path / "probe.js"
    probe.write_text("var __polykeyProbe = { report: () => ({}) };", encoding="utf-8")
    values = dict(
        devtools=fake.devtools,
        bundle=bundle,
        probe=probe,
        debounce=0.02,
        safety_check=0.3,
        backoff_start=0.02,
        backoff_max=0.1,
        uninstall_timeout=1.0,
    )
    values.update(overrides)
    return Config(**values)


async def start_service(cfg: Config, log: Log):
    stop = asyncio.Event()
    task = asyncio.ensure_future(injector.run_service(cfg, log, stop))
    return stop, task


async def stop_service(stop: asyncio.Event, task: asyncio.Future) -> None:
    stop.set()
    await asyncio.wait_for(task, 3)


def run(coro):
    return asyncio.run(coro)


def test_injects_once_and_leaves_a_running_instance_alone(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        stop, task = await start_service(fast_config(fake, tmp_path), Log(io.StringIO()))
        try:
            await until(lambda: fake.inject_count == 1)
            await asyncio.sleep(0.8)  # a few safety checks
            assert fake.inject_count == 1
        finally:
            await stop_service(stop, task)
            await fake.stop()

    run(main())


def test_reinjects_after_the_page_reloads(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        stop, task = await start_service(fast_config(fake, tmp_path, safety_check=30), Log(io.StringIO()))
        try:
            await until(lambda: fake.inject_count == 1)
            await fake.reload()
            await until(lambda: fake.inject_count == 2)  # from the context event, not the safety check
        finally:
            await stop_service(stop, task)
            await fake.stop()

    run(main())


def test_reconnects_and_reinjects_after_steam_restarts(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        stop, task = await start_service(fast_config(fake, tmp_path), Log(io.StringIO()))
        try:
            await until(lambda: fake.inject_count == 1)
            await fake.restart()
            await until(lambda: fake.inject_count == 2 and fake.connections == 2)
        finally:
            await stop_service(stop, task)
            await fake.stop()

    run(main())


def test_waits_while_steam_is_not_up_yet(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        fake.has_target = False
        out = io.StringIO()
        stop, task = await start_service(fast_config(fake, tmp_path), Log(out))
        try:
            await asyncio.sleep(0.2)
            assert fake.inject_count == 0
            assert out.getvalue().count("waiting for the SharedJSContext target") == 1  # logged once
            fake.has_target = True
            await until(lambda: fake.inject_count == 1)
        finally:
            await stop_service(stop, task)
            await fake.stop()

    run(main())


def test_stopping_removes_polykey_from_steam(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        out = io.StringIO()
        stop, task = await start_service(fast_config(fake, tmp_path), Log(out))
        await until(lambda: fake.injected)
        await stop_service(stop, task)
        assert fake.uninstall_count == 1
        assert not fake.injected
        assert "stock keyboard restored" in out.getvalue()
        await fake.stop()

    run(main())


def test_forwards_only_new_polykey_console_lines(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        out = io.StringIO()
        stop, task = await start_service(fast_config(fake, tmp_path, forward_console=True), Log(out))
        try:
            await until(lambda: fake.injected)
            await fake.console("[polykey]", "running 0.0.1")
            await fake.console("[polykey]", "check failed:", level="warning")
            await fake.console("Steam's own message")
            await fake.console("[polykey]", "replayed from before we connected", age_ms=60_000)
            await until(lambda: "check failed" in out.getvalue())
            text = out.getvalue()
            assert "page: running 0.0.1" in text
            assert "page warning: check failed:" in text
            assert "Steam's own message" not in text
            assert "replayed" not in text
        finally:
            await stop_service(stop, task)
            await fake.stop()

    run(main())


def test_console_lines_stay_out_of_the_log_unless_asked(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        out = io.StringIO()
        stop, task = await start_service(fast_config(fake, tmp_path), Log(out))
        try:
            await until(lambda: fake.injected)
            await fake.console("[polykey]", "running 0.0.1")
            await asyncio.sleep(0.3)
            assert "page:" not in out.getvalue()
        finally:
            await stop_service(stop, task)
            await fake.stop()

    run(main())


def test_console_forwarding_defaults_to_dev_builds_and_the_settings_switch(tmp_path, monkeypatch):
    from polykey import __main__ as cli

    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setattr(injector, "is_dev", lambda: False)
    assert cli.forward_console(None) is False
    (tmp_path / "polykey").mkdir()
    (tmp_path / "polykey" / "settings.json").write_text('{"console": true}', encoding="utf-8")
    assert cli.forward_console(None) is True
    assert cli.forward_console(False) is False
    (tmp_path / "polykey" / "settings.json").write_text('{"console": false}', encoding="utf-8")
    monkeypatch.setattr(injector, "is_dev", lambda: True)
    assert cli.forward_console(None) is True


def test_another_version_left_in_steam_is_replaced(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        fake.injected, fake.page_version, fake.injects_version = True, "0.1.0", "0.2.0"
        out = io.StringIO()
        cfg = fast_config(fake, tmp_path)
        (cfg.bundle.parent / "VERSION").write_text("0.2.0\n", encoding="utf-8")
        stop, task = await start_service(cfg, Log(out))
        try:
            await until(lambda: fake.inject_count == 1)
            await asyncio.sleep(0.4)  # a safety check later, the right version is left alone
            assert fake.inject_count == 1 and fake.page_version == "0.2.0"
            assert "Steam runs polykey 0.1.0; injecting 0.2.0" in out.getvalue()
        finally:
            await stop_service(stop, task)
            await fake.stop()

    run(main())


def test_a_version_in_the_page_that_is_not_a_release_is_not_logged(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        fake.injected, fake.page_version, fake.injects_version = True, "x" * 500 + "\nforged line", "0.2.0"
        out = io.StringIO()
        cfg = fast_config(fake, tmp_path)
        (cfg.bundle.parent / "VERSION").write_text("0.2.0\n", encoding="utf-8")
        stop, task = await start_service(cfg, Log(out))
        try:
            await until(lambda: fake.inject_count == 1)
            assert "Steam runs polykey ?; injecting 0.2.0" in out.getvalue()
            assert "forged" not in out.getvalue() and "xxx" not in out.getvalue()
        finally:
            await stop_service(stop, task)
            await fake.stop()

    run(main())


def test_a_release_marks_itself_started_once_it_reaches_steam(tmp_path, monkeypatch):
    code = tmp_path / "versions" / "0.1.0"
    code.mkdir(parents=True)
    monkeypatch.setattr(injector, "INSTALL_DIR", code)

    async def main():
        fake = await FakeSteam().start()
        fake.has_target = False
        stop, task = await start_service(fast_config(fake, tmp_path), Log(io.StringIO()))
        try:
            await asyncio.sleep(0.2)
            assert not (code / ".started").exists()  # not before it is in Steam
            fake.has_target = True
            await until(lambda: fake.inject_count == 1)
            assert (code / ".started").exists()
        finally:
            await stop_service(stop, task)
            await fake.stop()

    run(main())


def test_the_page_tells_the_updater_whether_the_keyboard_is_on_screen(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        page = injector.Page()
        assert await page.keyboard_hidden()  # no Steam page: no keyboard to interrupt
        stop = asyncio.Event()
        async with aiohttp.ClientSession() as http:
            target = find_target(await list_targets(http, fake.devtools), injector.TARGET_TITLE)
            cfg, log = fast_config(fake, tmp_path), Log(io.StringIO())
            task = asyncio.ensure_future(injector.watch_target(http, target, cfg, log, stop, page=page))
            try:
                await until(lambda: page.session is not None)
                fake.keyboard = "open"
                assert not await page.keyboard_hidden()
                fake.keyboard = "unknown"
                assert not await page.keyboard_hidden()
                fake.keyboard = "hidden"
                assert await page.keyboard_hidden()
            finally:
                stop.set()
                await asyncio.wait_for(task, 3)
        assert page.session is None
        await fake.stop()

    run(main())


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_the_keyboard_expression_reads_only_the_open_flag_from_the_page():
    line = "running keyboard=en/english open={} mode=buffered target=steam-ui overlay=- app=- popup=800x300"
    cases = [
        (None, "hidden"),  # no polykey in the page
        ({"state": "waiting", "status": line.format("true")}, "hidden"),  # not drawn yet
        ({"state": "blocked", "status": line.format("true")}, "hidden"),
        ({"state": "running", "status": line.format("true")}, "open"),
        ({"state": "running", "status": line.format("false")}, "hidden"),
        ({"state": "running", "status": "running keyboard=en/english status=unavailable popup=-"}, "unknown"),
        ({"state": "running", "status": None}, "unknown"),  # debug.status() throws
    ]
    script = """
const { expression, cases } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(JSON.stringify(cases.map((c) => {
  globalThis.__polykey = c && { state: c.state, debug: { status: () => {
    if (c.status === null) throw new Error('no status');
    return c.status;
  } } };
  return (0, eval)(expression);
})));
"""
    payload = json.dumps({"expression": injector.KEYBOARD_EXPRESSION, "cases": [c for c, _ in cases]})
    result = subprocess.run(["node", "-e", script], input=payload, capture_output=True, text=True, check=True)
    assert json.loads(result.stdout) == [want for _, want in cases]


def test_missing_bundle_is_reported_and_nothing_is_injected(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        out = io.StringIO()
        cfg = fast_config(fake, tmp_path, bundle=tmp_path / "nope.js")
        stop, task = await start_service(cfg, Log(out))
        try:
            await asyncio.sleep(0.5)
            assert fake.inject_count == 0
            assert out.getvalue().count("cannot read bundle") == 1
            assert not task.done()  # keeps running
        finally:
            await stop_service(stop, task)
            await fake.stop()

    run(main())


def test_once_injects_and_returns_zero(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        try:
            assert await injector.run_once(fast_config(fake, tmp_path), Log(io.StringIO())) == 0
            assert fake.inject_count == 1
        finally:
            await fake.stop()

    run(main())


def test_once_without_a_target_returns_one(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        fake.has_target = False
        try:
            assert await injector.run_once(fast_config(fake, tmp_path), Log(io.StringIO())) == 1
        finally:
            await fake.stop()

    run(main())


def test_uninstall_command(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        fake.injected = True
        try:
            assert await injector.run_uninstall(fast_config(fake, tmp_path), Log(io.StringIO())) == 0
            assert fake.uninstall_count == 1 and not fake.injected
        finally:
            await fake.stop()

    run(main())


def test_probe_prints_the_report_and_targets(tmp_path):
    async def main():
        fake = await FakeSteam().start()
        out = io.StringIO()
        try:
            assert await injector.run_probe(fast_config(fake, tmp_path), Log(out)) == 0
            text = out.getvalue()
            assert '"keyboardManagers": 1' in text
            assert "SteamVR - Keyboard" in text
            assert fake.inject_count == 0  # read-only
        finally:
            await fake.stop()

    run(main())


def test_debugger_unreachable_is_retried_quietly(tmp_path):
    async def main():
        out = io.StringIO()
        cfg = Config(devtools="http://127.0.0.1:9", backoff_start=0.02, backoff_max=0.05, bundle=tmp_path / "bundle.js")
        stop, task = await start_service(cfg, Log(out))
        await asyncio.sleep(0.3)
        await stop_service(stop, task)
        assert out.getvalue().count("debugger unavailable") == 1

    run(main())


@pytest.mark.parametrize("endpoint", ["http://192.168.1.20:8080", "http://frame:8081", "http://0.0.0.0:8080"])
def test_refuses_non_loopback_debuggers(endpoint):
    with pytest.raises(ValueError):
        check_loopback(endpoint)


def test_accepts_loopback_debuggers():
    for endpoint in ("http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080"):
        check_loopback(endpoint)
