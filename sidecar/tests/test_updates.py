from __future__ import annotations

import asyncio
import hashlib
import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from aiohttp import web

from polykey.bridge import Bridge
from polykey.injector import Log
from polykey.updates import DEFAULT_SOURCE, GITHUB_HOSTS, Updater, parse_manifest, UpdateError
from polykey.versions import Versions
from test_versions import hold_lock, make_tarball

pytestmark = pytest.mark.skipif(shutil.which("ssh-keygen") is None, reason="needs ssh-keygen")


@pytest.fixture(scope="module")
def key(tmp_path_factory):
    """A throwaway release key, and an allowed_signers file naming it."""
    folder = tmp_path_factory.mktemp("key")
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", str(folder / "key")], check=True)
    public = " ".join((folder / "key.pub").read_text().split()[:2])
    (folder / "allowed_signers").write_text(f'polykey-release namespaces="polykey-release" {public}\n')
    return folder


def sign(key: Path, data: bytes, tmp: Path) -> bytes:
    path = tmp / "to-sign.json"
    path.write_bytes(data)
    subprocess.run(
        ["ssh-keygen", "-q", "-Y", "sign", "-f", str(key / "key"), "-n", "polykey-release", str(path)], check=True
    )
    signature = path.with_name("to-sign.json.sig").read_bytes()
    path.with_name("to-sign.json.sig").unlink()
    return signature


class Release:
    """A release source on localhost: latest.json, its signature and a tarball."""

    def __init__(self, key: Path, tmp: Path) -> None:
        self.key, self.tmp = key, tmp
        self.files: dict[str, bytes] = {}
        self.requests: list[str] = []
        self.base = ""

    def publish(self, version: str, *, signed_by: Path | None = None, extra=None) -> None:
        tarball = make_tarball(self.tmp / f"src-{version}.tar.gz", version, extra).read_bytes()
        manifest = {
            "format": 1,
            "version": version,
            "size": len(tarball),
            "sha256": hashlib.sha256(tarball).hexdigest(),
        }
        data = json.dumps(manifest).encode()
        self.files = {
            "latest.json": data,
            "latest.json.sig": sign(signed_by or self.key, data, self.tmp),
            f"polykey-{version}.tar.gz": tarball,
        }

    async def start(self):
        async def handler(request):
            name = request.match_info["name"]
            self.requests.append(name)
            return web.Response(body=self.files[name]) if name in self.files else web.Response(status=404)

        app = web.Application()
        app.add_routes([web.get("/{name}", handler)])
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        return self

    async def stop(self):
        await self.runner.cleanup()


@pytest.fixture
def home(tmp_path):
    """versions/0.1.0 installed and current, settings pointing at the local source."""
    versions = Versions(tmp_path / "polykey")
    versions.unpack(make_tarball(tmp_path / "first.tar.gz", "0.1.0"), "0.1.0")
    versions.activate("0.1.0")
    return versions, tmp_path / "settings.json"


def updater(versions, settings, key, *, version="0.1.0", dev=False, restarts=None, signers=None, **kw):
    async def restart():
        if restarts is not None:
            restarts.append(versions.current())
        return True

    return Updater(
        Log(io.StringIO()),
        settings,
        version,
        dev,
        signers or key / "allowed_signers",
        versions,
        restart=restart,
        first_check=0.01,
        interval=3600,
        unit=settings.parent / "polykey.service",
        keyboard_poll=0.01,
        **kw,
    )


class Keyboard:
    """What injector.Page would say: whether polykey's keyboard is off screen, and how often it was asked."""

    def __init__(self, hidden: bool) -> None:
        self.hidden, self.asked = hidden, 0

    async def __call__(self) -> bool:
        self.asked += 1
        return self.hidden


def settings_for(settings: Path, base: str, **more) -> None:
    settings.write_text(json.dumps({"updateUrl": base, **more}))


async def finish(up: Updater) -> dict:
    if up._task is not None:
        await up._task
    return up.status()


def run(coro):
    return asyncio.run(coro)


def test_a_newer_signed_release_is_installed_and_the_service_restarts_into_it(home, key, tmp_path):
    versions, settings = home

    async def main():
        source = await Release(key, tmp_path).start()
        source.publish("0.2.0")
        settings_for(settings, source.base)
        restarts = []
        up = updater(versions, settings, key, restarts=restarts)
        try:
            reply = await up.handle("update.check", {})
            assert reply["ok"] and reply["state"] == "checking"
            status = await finish(up)
        finally:
            await source.stop()
        assert versions.current() == "0.2.0" and versions.previous() == "0.1.0"
        assert restarts == ["0.2.0"] and status["state"] == "restarting"
        assert not list((versions.root / "updates").glob("*.tar.gz"))  # the download is removed once unpacked

    run(main())


def test_with_auto_update_off_a_check_only_reports_and_install_is_asked_for(home, key, tmp_path):
    versions, settings = home

    async def main():
        source = await Release(key, tmp_path).start()
        source.publish("0.2.0")
        settings_for(settings, source.base, autoUpdate=False)
        up = updater(versions, settings, key)
        try:
            await up.handle("update.check", {})
            status = await finish(up)
            assert status["available"] and status["latest"] == "0.2.0"
            assert versions.current() == "0.1.0"
            assert (await up.handle("update.install", {"version": "0.9.9"}))["error"] == "not-offered"
            await up.handle("update.install", {"version": "0.2.0"})
            await finish(up)
        finally:
            await source.stop()
        assert versions.current() == "0.2.0"

    run(main())


@pytest.mark.parametrize(
    "problem, code",
    [
        ("other-key", "bad-signature"),
        ("edited", "bad-signature"),
        ("no-key", "bad-signature"),
    ],
)
def test_a_manifest_that_does_not_check_out_installs_nothing(home, key, tmp_path, problem, code):
    versions, settings = home
    other = tmp_path / "other"
    if problem == "other-key":
        other.mkdir()
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(other / "key")], check=True)

    async def main():
        source = await Release(key, tmp_path).start()
        signers = None
        if problem == "other-key":
            source.publish("0.2.0", signed_by=other)
        else:
            source.publish("0.2.0")
        if problem == "edited":
            source.files["latest.json"] = source.files["latest.json"].replace(b'"0.2.0"', b'"0.3.0"')
        if problem == "no-key":
            signers = tmp_path / "empty_signers"
            signers.write_text("# no key yet\n")
        settings_for(settings, source.base)
        up = updater(versions, settings, key, signers=signers)
        try:
            await up.handle("update.check", {})
            status = await finish(up)
        finally:
            await source.stop()
        assert status["error"] == code and status["latest"] is None
        assert versions.current() == "0.1.0" and versions.installed() == ["0.1.0"]
        assert not any(name.endswith(".tar.gz") for name in source.requests)

    run(main())


def test_a_tarball_that_does_not_match_its_hash_is_dropped(home, key, tmp_path):
    versions, settings = home

    async def main():
        source = await Release(key, tmp_path).start()
        source.publish("0.2.0")
        tarball = source.files["polykey-0.2.0.tar.gz"]
        source.files["polykey-0.2.0.tar.gz"] = tarball[:-1] + bytes([tarball[-1] ^ 1])
        settings_for(settings, source.base)
        up = updater(versions, settings, key)
        try:
            await up.handle("update.check", {})
            status = await finish(up)
        finally:
            await source.stop()
        assert status["error"] == "bad-hash" and versions.current() == "0.1.0"
        assert versions.installed() == ["0.1.0"] and not list((versions.root / "updates").glob("*.tar.gz*"))

    run(main())


def test_a_dev_build_reports_but_never_installs(home, key, tmp_path):
    versions, settings = home

    async def main():
        source = await Release(key, tmp_path).start()
        source.publish("0.2.0")
        settings_for(settings, source.base)
        up = updater(versions, settings, key, version="0.1.0+dev.3.gabc1234", dev=True)
        try:
            stop = asyncio.Event()
            await asyncio.wait_for(up.run(stop), 1)  # no automatic checks at all
            assert source.requests == []
            await up.handle("update.check", {})
            status = await finish(up)
            assert status["latest"] == "0.2.0" and not status["available"] and status["dev"]
            assert (await up.handle("update.install", {"version": "0.2.0"}))["error"] == "dev"
        finally:
            await source.stop()
        assert versions.current() == "0.1.0"

    run(main())


def test_automatic_checks_skip_a_release_rolled_back_from_until_asked(home, key, tmp_path):
    versions, settings = home
    versions.unpack(make_tarball(tmp_path / "second.tar.gz", "0.2.0"), "0.2.0")
    versions.activate("0.2.0")
    versions.rollback()

    async def main():
        source = await Release(key, tmp_path).start()
        source.publish("0.2.0")
        settings_for(settings, source.base)
        up = updater(versions, settings, key)
        stop = asyncio.Event()
        checks = asyncio.ensure_future(up.run(stop))
        try:
            for _ in range(200):
                if up.latest:
                    break
                await asyncio.sleep(0.01)
            status = await finish(up)
            assert status["available"] and status["skipped"] and versions.current() == "0.1.0"
            # Still on disk from before: installing it again needs no download.
            await up.handle("update.install", {"version": "0.2.0"})
            await finish(up)
            assert versions.current() == "0.2.0" and versions.skipped() is None
            assert "polykey-0.2.0.tar.gz" not in source.requests
        finally:
            stop.set()
            await checks
            await source.stop()

    run(main())


def test_an_automatic_install_restarts_only_once_the_keyboard_is_hidden(home, key, tmp_path):
    versions, settings = home

    async def main():
        source = await Release(key, tmp_path).start()
        source.publish("0.2.0")
        settings_for(settings, source.base)
        restarts, keyboard = [], Keyboard(hidden=False)
        up = updater(versions, settings, key, restarts=restarts, keyboard_hidden=keyboard)
        try:
            await up.handle("update.check", {})
            for _ in range(500):
                if keyboard.asked >= 5:
                    break
                await asyncio.sleep(0.01)
            # Installed and current (the next start runs it), but no restart while the keyboard is up.
            assert up.status()["state"] == "installed" and up.status()["latest"] == "0.2.0"
            assert versions.current() == "0.2.0" and restarts == []
            keyboard.hidden = True
            status = await finish(up)
        finally:
            await source.stop()
        assert restarts == ["0.2.0"] and status["state"] == "restarting"

    run(main())


def test_asking_for_the_install_restarts_at_once_keyboard_or_not(home, key, tmp_path):
    versions, settings = home

    async def main():
        source = await Release(key, tmp_path).start()
        source.publish("0.2.0")
        settings_for(settings, source.base)
        restarts, keyboard = [], Keyboard(hidden=False)
        up = updater(versions, settings, key, restarts=restarts, keyboard_hidden=keyboard)
        try:
            await up.handle("update.check", {})  # auto-update: installs, then waits for the keyboard
            for _ in range(500):
                if up.state == "installed":
                    break
                await asyncio.sleep(0.01)
            assert restarts == []
            await up.handle("update.install", {"version": "0.2.0"})  # Install: now
            await finish(up)
            assert restarts == ["0.2.0"]
            # Restarting: Back would go to the release still running, so it is not offered.
            assert up.state == "restarting" and "previous" not in up.status()
        finally:
            await source.stop()

        # With auto-update off, Install restarts at once too, without asking about the keyboard.
        versions.rollback()
        asked = keyboard.asked
        source = await Release(key, tmp_path).start()
        source.publish("0.3.0")
        settings_for(settings, source.base, autoUpdate=False)
        up = updater(versions, settings, key, restarts=restarts, keyboard_hidden=keyboard)
        try:
            await up.handle("update.check", {})
            await finish(up)
            await up.handle("update.install", {"version": "0.3.0"})
            await finish(up)
        finally:
            await source.stop()
        assert restarts == ["0.2.0", "0.3.0"] and keyboard.asked == asked

    run(main())


def test_an_install_waiting_for_the_keyboard_offers_back_which_needs_no_restart(home, key, tmp_path):
    versions, settings = home

    async def main():
        source = await Release(key, tmp_path).start()
        source.publish("0.2.0")
        settings_for(settings, source.base)
        restarts = []
        up = updater(versions, settings, key, restarts=restarts, keyboard_hidden=Keyboard(hidden=False))
        try:
            await up.handle("update.check", {})
            for _ in range(500):
                if up.state == "installed":
                    break
                await asyncio.sleep(0.01)
            # 0.2.0 is current, 0.1.0 still runs: Back goes to the running release, and is offered.
            waiting, current = await up.handle("update.status", {}), versions.current()
            reply = await up.handle("update.rollback", {})
        finally:
            await source.stop()
        assert waiting["state"] == "installed" and current == "0.2.0"
        assert waiting["version"] == waiting["previous"] == "0.1.0"
        # 0.1.0 still runs: it is current again, 0.2.0 is skipped, and nothing restarts.
        assert reply["ok"] and reply["state"] == "idle" and reply["skipped"] and "previous" not in reply
        assert versions.current() == "0.1.0" and versions.skipped() == "0.2.0" and restarts == []

    run(main())


def test_an_update_waits_for_another_writer_without_stopping_the_service(home, key, tmp_path):
    versions, settings = home
    versions.unpack(make_tarball(tmp_path / "second.tar.gz", "0.2.0"), "0.2.0")  # no download: straight to activate

    async def main():
        source = await Release(key, tmp_path).start()
        source.publish("0.2.0")
        settings_for(settings, source.base)
        restarts = []
        up = updater(versions, settings, key, restarts=restarts)
        holder = hold_lock(versions, 0.5)  # install.sh is unpacking
        try:
            await up.handle("update.check", {})
            ticks = 0
            while not up._task.done():
                await asyncio.sleep(0.01)
                ticks += 1
        finally:
            holder.join()
            await source.stop()
        assert ticks >= 20  # the loop (the bridge, injection) kept running while activate waited
        assert restarts == ["0.2.0"] and versions.current() == "0.2.0"

    run(main())


def test_rollback_from_settings_goes_back_and_restarts(home, key, tmp_path):
    versions, settings = home
    versions.unpack(make_tarball(tmp_path / "second.tar.gz", "0.2.0"), "0.2.0")
    versions.activate("0.2.0")

    async def main():
        restarts = []
        up = updater(versions, settings, key, version="0.2.0", restarts=restarts)
        assert up.status()["previous"] == "0.1.0"
        reply = await up.handle("update.rollback", {})
        await finish(up)
        assert reply["ok"] and restarts == ["0.1.0"] and versions.skipped() == "0.2.0"
        assert (await updater(versions, settings, key).handle("update.rollback", {}))["error"] == "no-previous"

    run(main())


def test_an_unusable_update_url_means_the_default_source(home, key):
    versions, settings = home
    up = updater(versions, settings, key)
    for url in ("http://[bad", "ftp://example.com/", "nonsense", 3):
        settings.write_text(json.dumps({"updateUrl": url}))
        assert up.source() == (DEFAULT_SOURCE, GITHUB_HOSTS, ("https",))
    settings.write_text(json.dumps({"updateUrl": "http://192.168.1.5:8000/r"}))
    assert up.source() == ("http://192.168.1.5:8000/r/", ("192.168.1.5", *GITHUB_HOSTS), ("http", "https"))


def test_a_malformed_redirect_ends_the_check_instead_of_hanging_it(home, key, tmp_path):
    versions, settings = home

    async def main():
        async def bad(_request):
            return web.Response(status=302, headers={"Location": "http://[bad"})

        app = web.Application()
        app.add_routes([web.get("/{name}", bad)])
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        settings_for(settings, f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}")
        up = updater(versions, settings, key)
        try:
            await up.handle("update.check", {})
            status = await finish(up)
        finally:
            await runner.cleanup()
        assert status["state"] == "idle" and status["error"]

    run(main())


def test_install_never_goes_back_to_an_older_release(home, key, tmp_path):
    versions, settings = home

    async def main():
        source = await Release(key, tmp_path).start()
        source.publish("0.0.9")
        settings_for(settings, source.base, autoUpdate=False)
        up = updater(versions, settings, key)
        try:
            await up.handle("update.check", {})
            status = await finish(up)
            assert not status["available"]
            assert (await up.handle("update.install", {"version": "0.0.9"}))["error"] == "not-newer"
        finally:
            await source.stop()
        assert versions.current() == "0.1.0"

    run(main())


def test_status_waits_for_a_change(home, key):
    versions, settings = home

    async def main():
        up = updater(versions, settings, key)
        rev = up.status()["rev"]
        waiting = asyncio.ensure_future(up.handle("update.status", {"since": rev, "timeoutMs": 5000}))
        await asyncio.sleep(0.05)
        assert not waiting.done()
        up._set("checking")
        assert (await asyncio.wait_for(waiting, 1))["state"] == "checking"
        assert (await up.handle("update.status", {"since": rev + 100, "timeoutMs": 5000}))["rev"] == rev + 1

    run(main())


def test_a_release_with_a_new_unit_replaces_the_installed_one(home, key, tmp_path):
    versions, settings = home
    unit = settings.parent / "polykey.service"
    unit.write_text("[Service]\nold\n")

    async def main():
        source = await Release(key, tmp_path).start()
        source.publish("0.2.0", extra={"polykey.service": "[Service]\nnew\n"})
        settings_for(settings, source.base)
        up = updater(versions, settings, key)
        try:
            await up.handle("update.check", {})
            await finish(up)
        finally:
            await source.stop()
        assert unit.read_text() == "[Service]\nnew\n"

    run(main())


def test_manifest_fields_are_checked():
    good = {"format": 1, "version": "1.2.3", "size": 10, "sha256": "a" * 64}
    assert parse_manifest(json.dumps(good).encode()) == {"version": "1.2.3", "size": 10, "sha256": "a" * 64}
    for change in (
        {"format": 0},
        {"version": "v1.2.3"},
        {"version": "1.2.3+dev"},
        {"size": True},
        {"size": 1 << 40},
        {"sha256": "A" * 64},
    ):
        with pytest.raises(UpdateError):
            parse_manifest(json.dumps({**good, **change}).encode())


def test_the_bridge_routes_update_requests_and_saves_auto_update(home, key, tmp_path):
    versions, settings = home

    async def main():
        bridge = Bridge(Log(io.StringIO()), settings_path=settings, updates=updater(versions, settings, key))
        reply = await bridge.handle(json.dumps({"id": 3, "op": "update.status"}))
        assert reply["id"] == 3 and reply["version"] == "0.1.0"
        saved = await bridge.handle(json.dumps({"id": 4, "op": "settings.save", "settings": {"autoUpdate": False}}))
        assert saved["ok"] and json.loads(settings.read_text())["autoUpdate"] is False
        assert (await Bridge(Log(io.StringIO())).handle(json.dumps({"id": 6, "op": "update.check"})))[
            "error"
        ] == "unavailable"

    run(main())
