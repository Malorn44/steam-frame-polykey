"""Updates for an installed release, run by the service.

A minute after start and then every hour it reads latest.json and latest.json.sig from the release
source (the latest GitHub release, or settings.json "updateUrl"), and believes the manifest only when
`ssh-keygen -Y verify` says the release key in this release's allowed_signers signed it. A newer
release is downloaded (pinned by the manifest's size and sha256, from the source's hosts only),
unpacked into versions/<version>/ and made current; then the service restarts into it. With
settings.json "autoUpdate": false (Settings → Update automatically) checks only report.

An automatic install waits for the keyboard to be hidden before it restarts (state "installed"), so
polykey never leaves Steam's popup mid-word; an install asked for (update.install) restarts at once.

Never on a dev build (dev/ with its DEV marker, or a checkout): it reports, and installs nothing.
A release rolled back from (versions.py) is left alone by automatic installs until a newer one
comes; Install puts it back on request.

The page asks over the bridge:
  update.status {since?, timeoutMs?}  {version, dev, state, latest?, available, skipped,
                                       previous?, error?, done?, total?, rev}; with `since`, it
                                       answers once `rev` is not that any more, or on timeout
  update.check                        check now (and install, with auto-update on)
  update.install {version}            install the release the last check found (or, while an
                                       automatic install waits in "installed", restart into it now)
  update.rollback                     go back to the release before this one, and restart into it
                                       (unless it is the release still running)
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Awaitable, Callable, Optional
from urllib.parse import urljoin, urlsplit

import aiohttp

from .speech.download import Download, Remote, host_allowed
from .versions import DEV, VersionError, Versions, is_release, newer

OPS = ("update.status", "update.check", "update.install", "update.rollback")
DEFAULT_SOURCE = "https://github.com/Malorn44/steam-frame-polykey/releases/latest/download/"
GITHUB_HOSTS = ("github.com", "githubusercontent.com")  # release assets redirect to *.githubusercontent.com
NAMESPACE = "polykey-release"
FIRST_CHECK = 60.0
INTERVAL = 3600.0
MAX_SMALL = 64 << 10  # latest.json and its signature
MAX_TARBALL = 64 << 20
MAX_REDIRECTS = 5
MAX_WAIT = 30.0
VERIFY_TIMEOUT = 15.0
KEYBOARD_POLL = 5.0  # an automatic install restarts once the keyboard is hidden at two readings in a row
HIDDEN_READINGS = 2
SHA256 = re.compile(r"^[0-9a-f]{64}$")
UNIT = "polykey.service"


class UpdateError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def has_key(signers: Path) -> bool:
    try:
        return any(
            line.startswith(f"{NAMESPACE} ") and "ssh-ed25519 " in line
            for line in signers.read_text(encoding="utf-8").splitlines()
        )
    except OSError:
        return False


async def verify(manifest: bytes, signature: bytes, signers: Path, work: Path) -> None:
    """Raise UpdateError unless the release key signed the manifest."""
    if not has_key(signers):
        raise UpdateError("no-key")
    exe = shutil.which("ssh-keygen")
    if exe is None:
        raise UpdateError("no-verifier")
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=work, suffix=".sig") as sig:
        sig.write(signature)
        sig.flush()
        proc = await asyncio.create_subprocess_exec(
            exe,
            "-Y",
            "verify",
            "-f",
            str(signers),
            "-I",
            NAMESPACE,
            "-n",
            NAMESPACE,
            "-s",
            sig.name,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await asyncio.wait_for(proc.communicate(manifest), VERIFY_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise UpdateError("no-verifier") from None
    if proc.returncode != 0:
        raise UpdateError("bad-signature")


def parse_manifest(data: bytes, hosts: tuple[str, ...], schemes: tuple[str, ...]) -> dict:
    try:
        manifest = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise UpdateError("bad-manifest") from None
    if not isinstance(manifest, dict) or manifest.get("format") != 1 or not is_release(manifest.get("version")):
        raise UpdateError("bad-manifest")
    url, size, sha = manifest.get("url"), manifest.get("size"), manifest.get("sha256")
    if not isinstance(url, str) or not host_allowed(url, hosts, schemes):
        raise UpdateError("bad-manifest")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_TARBALL:
        raise UpdateError("bad-manifest")
    if not isinstance(sha, str) or not SHA256.match(sha):
        raise UpdateError("bad-manifest")
    notes = manifest.get("notes")
    return {
        "version": manifest["version"],
        "url": url,
        "size": size,
        "sha256": sha,
        "notes": notes if isinstance(notes, str) and host_allowed(notes, hosts, ("https",)) else None,
    }


async def fetch(
    http: aiohttp.ClientSession, url: str, hosts: tuple[str, ...], schemes: tuple[str, ...], limit: int
) -> bytes:
    """GET a small file, following redirects only within the allowed hosts."""
    for _ in range(MAX_REDIRECTS + 1):
        if not host_allowed(url, hosts, schemes):
            raise UpdateError("bad-host")
        async with http.get(url, allow_redirects=False) as response:
            if response.status in (301, 302, 303, 307, 308):
                url = urljoin(url, response.headers.get("Location", ""))
                continue
            if response.status != 200:
                raise UpdateError("network" if response.status >= 500 or response.status == 429 else "no-release")
            body = bytearray()
            async for chunk in response.content.iter_chunked(8192):
                body += chunk
                if len(body) > limit:
                    raise UpdateError("bad-manifest")
            return bytes(body)
    raise UpdateError("network")


async def restart_service() -> bool:
    """Ask systemd to restart the service (it stops us, which removes polykey from Steam, then starts the
    new current). False when not running under systemd: the new release waits for the next start."""
    if not os.environ.get("INVOCATION_ID") or shutil.which("systemctl") is None:
        return False
    proc = await asyncio.create_subprocess_exec(
        "systemctl",
        "--user",
        "--no-block",
        "restart",
        UNIT,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    return await proc.wait() == 0


def unit_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "systemd" / "user" / UNIT


class Updater:
    def __init__(
        self,
        log,
        settings_path: Optional[Path],
        version: str,
        dev: bool,
        signers: Path,
        versions: Optional[Versions] = None,
        restart: Callable[[], Awaitable[bool]] = restart_service,
        first_check: float = FIRST_CHECK,
        interval: float = INTERVAL,
        unit: Optional[Path] = None,
        keyboard_hidden: Optional[Callable[[], Awaitable[bool]]] = None,
        keyboard_poll: float = KEYBOARD_POLL,
    ) -> None:
        self._log = log
        self._settings_path = settings_path
        self.version = version
        self.dev = dev
        self._signers = signers
        self.versions = versions or Versions()
        self._restart = restart
        self._first_check = first_check
        self._interval = interval
        self._unit = unit or unit_path()
        # Whether polykey's keyboard is off screen (injector.Page); None: no way to tell, restart at once.
        self._keyboard_hidden = keyboard_hidden
        self._keyboard_poll = keyboard_poll
        self.state = "idle"  # idle | checking | downloading | installing | installed | restarting
        self.error: Optional[str] = None
        self.latest: Optional[dict] = None
        self._download: Optional[Download] = None
        self._task: Optional[asyncio.Task] = None
        self._logged: Optional[str] = None
        self._unit_changed = False
        self._pending: Optional[str] = None  # installed, waiting for the keyboard to be hidden
        self._restart_now = asyncio.Event()
        self.rev = 0
        self._changed = asyncio.Event()

    # --- settings ---------------------------------------------------------------------------------

    def _settings(self) -> dict:
        try:
            data = json.loads(self._settings_path.read_text(encoding="utf-8")) if self._settings_path else {}
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def auto(self) -> bool:
        return self._settings().get("autoUpdate") is not False

    def source(self) -> tuple[str, tuple[str, ...], tuple[str, ...]]:
        """(base URL, allowed hosts, allowed schemes): GitHub, or settings.json "updateUrl" when it is a
        usable http(s) URL."""
        url = self._settings().get("updateUrl")
        try:
            parts = urlsplit(url) if isinstance(url, str) else None
            host = parts.hostname if parts else None
        except ValueError:  # "http://[bad": never leave a check saying "checking"
            parts = host = None
        if parts and parts.scheme in ("http", "https") and host:
            base = url if url.endswith("/") else url + "/"
            return (
                base,
                (host.lower(), *GITHUB_HOSTS),
                (("http", "https") if parts.scheme == "http" else ("https",)),
            )
        return DEFAULT_SOURCE, GITHUB_HOSTS, ("https",)

    # --- status -----------------------------------------------------------------------------------

    def _bump(self) -> None:
        self.rev += 1
        self._changed.set()
        self._changed = asyncio.Event()

    def status(self) -> dict:
        latest = self.latest["version"] if self.latest else None
        out = {
            "ok": True,
            "rev": self.rev,
            "version": self.version,
            "dev": self.dev,
            "state": self.state,
            "latest": latest,
            "available": bool(latest and not self.dev and newer(latest, self.version)),
            "skipped": bool(latest and latest == self.versions.skipped()),
        }
        previous = self.versions.previous()
        # While an automatic install waits for the keyboard, `current` is the new release and Back
        # goes to the one still running: offer it then, and in no other state.
        if previous and (previous != self.version or self.state == "installed"):
            out["previous"] = previous
        if self.error:
            out["error"] = self.error
        if self.state == "downloading" and self._download is not None:
            out["done"], out["total"] = self._download.done, self._download.total
        return out

    async def wait(self, since: object, timeout_ms: object) -> None:
        if not isinstance(since, int) or since != self.rev:
            return
        seconds = min(max(timeout_ms / 1000, 0), MAX_WAIT) if isinstance(timeout_ms, (int, float)) else 10.0
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._changed.wait(), seconds)

    def _set(self, state: str, error: Optional[str] = None) -> None:
        self.state, self.error = state, error
        self._bump()

    def _note(self, message: str) -> None:
        """A line for the journal, once per distinct message in a row (an hourly failure logs once)."""
        if message != self._logged:
            self._logged = message
            self._log.info(f"update: {message}")

    # --- requests ---------------------------------------------------------------------------------

    async def handle(self, op: str, request: dict) -> dict:
        if op == "update.status":
            await self.wait(request.get("since"), request.get("timeoutMs"))
            return self.status()
        if op == "update.rollback":
            return await self.rollback()
        if op == "update.install" and self._pending is not None and request.get("version") == self._pending:
            self._restart_now.set()  # asked for: restart now, keyboard or not
            await asyncio.sleep(0)
            return self.status()
        if self._task is not None and not self._task.done():
            return self.status()  # one check or install at a time; the page follows status
        if op == "update.check":
            self._task = asyncio.ensure_future(self.check(manual=True))
        else:
            version = request.get("version")
            if self.dev:
                return {"ok": False, "error": "dev"}
            if not self.latest or version != self.latest["version"]:
                return {"ok": False, "error": "not-offered"}
            if not newer(version, self.version):
                return {"ok": False, "error": "not-newer"}  # going back is Back, which skips what it left
            self._task = asyncio.ensure_future(self.install(version, asked=True))
        await asyncio.sleep(0)  # let it reach its first state
        return self.status()

    # --- work -------------------------------------------------------------------------------------

    async def check(self, manual: bool = False) -> None:
        self._set("checking", None)
        base, hosts, schemes = self.source()
        timeout = aiohttp.ClientTimeout(total=60, connect=15)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as http:
                manifest = await fetch(http, urljoin(base, "latest.json"), hosts, schemes, MAX_SMALL)
                signature = await fetch(http, urljoin(base, "latest.json.sig"), hosts, schemes, MAX_SMALL)
            await verify(manifest, signature, self._signers, self.versions.root / "updates")
            self.latest = parse_manifest(manifest, hosts, schemes)
        except UpdateError as error:
            self._fail(error.code)
            return
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError):
            self._fail("network")  # ValueError: a malformed URL or redirect
            return
        except Exception as error:  # never leave the line saying "checking"
            self._fail(f"failed-{type(error).__name__}"[:32])
            return
        latest = self.latest["version"]
        if self.dev or not newer(latest, self.version):
            self._note(
                f"{self.version} is up to date" if not self.dev else f"dev build; the latest release is {latest}"
            )
            self._set("idle")
            return
        skipped = latest == self.versions.skipped()
        self._note(f"{latest} is available" + (" (rolled back from; install it from Settings)" if skipped else ""))
        self._set("idle")
        if self.auto() and not skipped:
            await self.install(latest)

    def _fail(self, code: str) -> None:
        self._note(f"check failed: {code}")
        self._set("idle", code)

    async def install(self, version: str, asked: bool = False) -> None:
        """Download, unpack and activate `version`, then restart into it: at once when it was asked
        for, else once the keyboard is hidden."""
        if self.dev or not self.latest or self.latest["version"] != version:
            return
        _, hosts, schemes = self.source()
        loop = asyncio.get_running_loop()  # versions/ changes off the loop: they may wait for install.sh
        try:
            if version not in self.versions.installed():
                work = self.versions.root / "updates"
                download = Download(
                    Remote(self.latest["url"], self.latest["size"], self.latest["sha256"], hosts),
                    work / f"polykey-{version}.tar.gz",
                    schemes=schemes,
                    on_progress=self._bump,
                )
                self._download = download
                self._note(f"downloading {version}")
                self._set("downloading")
                if not await download.run():
                    raise UpdateError(download.error or "network")
                self._set("installing")
                try:
                    await loop.run_in_executor(None, self.versions.unpack, download.path, version)
                finally:
                    with contextlib.suppress(OSError):
                        download.path.unlink()
            else:
                self._set("installing")
            self._update_unit(version)
            await loop.run_in_executor(None, functools.partial(self.versions.activate, version, running=self.version))
        except (UpdateError, VersionError) as error:
            self._note(f"install of {version} failed: {error.code}")
            self._set("idle", error.code)
            return
        except OSError:
            self._note(f"install of {version} failed: disk")
            self._set("idle", "disk")
            return
        except Exception as error:  # never leave the line saying "downloading"
            self._note(f"install of {version} failed: {type(error).__name__}")
            self._set("idle", f"failed-{type(error).__name__}"[:32])
            return
        finally:
            self._download = None
        if not asked and self._keyboard_hidden is not None:
            await self._wait_until_hidden(version)
        await self._restart_into(version)

    async def _wait_until_hidden(self, version: str) -> None:
        """Hold an automatic install's restart until the keyboard has been hidden for a moment: a restart
        removes polykey from Steam's popup, which mid-word would lose a reading being composed. If the
        keyboard is never hidden, nothing is lost: `current` already points at `version`, so the
        service's next start runs it. update.install for `version` ends the wait at once."""
        self._pending = version
        self._restart_now.clear()
        self._note(f"{version} is installed; polykey restarts into it when the keyboard is hidden")
        self._set("installed")
        try:
            hidden = 0
            while hidden < HIDDEN_READINGS and not self._restart_now.is_set():
                hidden = hidden + 1 if await self._keyboard_is_hidden() else 0
                if hidden < HIDDEN_READINGS:
                    with contextlib.suppress(asyncio.TimeoutError):
                        await asyncio.wait_for(self._restart_now.wait(), self._keyboard_poll)
        finally:
            self._pending = None

    async def _keyboard_is_hidden(self) -> bool:
        try:
            return self._keyboard_hidden is None or await self._keyboard_hidden() is True
        except Exception:  # cannot tell: keep waiting
            return False

    def _update_unit(self, version: str) -> None:
        """A release may change the unit: write its copy over the installed one when they differ."""
        new = self.versions.versions / version / UNIT
        with contextlib.suppress(OSError):
            if new.is_file() and self._unit.is_file() and new.read_bytes() != self._unit.read_bytes():
                tmp = self._unit.with_name(UNIT + ".new")
                tmp.write_bytes(new.read_bytes())
                os.replace(tmp, self._unit)
                self._unit_changed = True

    async def _restart_into(self, version: str) -> None:
        self._set("restarting")
        if self._unit_changed and shutil.which("systemctl"):
            proc = await asyncio.create_subprocess_exec("systemctl", "--user", "daemon-reload")
            await proc.wait()
        self._note(f"switched to {version}; restarting")
        if not await self._restart():
            self._note(f"{version} starts with the next restart of polykey")
            self._set("idle", "restart-needed")

    async def rollback(self) -> dict:
        if self._pending is not None and self._task is not None and not self._task.done():
            # Back before the restart into an automatic install: stop waiting for the keyboard.
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._set("idle")
        elif self._task is not None and not self._task.done():
            return {"ok": False, "error": "busy"}
        try:
            before, after = await asyncio.get_running_loop().run_in_executor(None, self.versions.rollback)
        except VersionError as error:
            return {"ok": False, "error": error.code}
        except OSError:
            return {"ok": False, "error": "disk"}
        self._note(
            f"rolled back from {before} to {after}"
            + ("" if before == DEV else f"; {before} is skipped until a newer release")
        )
        if after == self.version:
            self._set("idle")  # back to the release still running: nothing to restart into
            return self.status()
        self._task = asyncio.ensure_future(self._restart_into(after))
        await asyncio.sleep(0)
        return self.status()

    async def run(self, stop: asyncio.Event) -> None:
        """Automatic checks: FIRST_CHECK after start, then every INTERVAL. None for a dev build."""
        if self.dev:
            return
        delay = self._first_check
        while not stop.is_set():
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), delay)
            if stop.is_set():
                break
            delay = self._interval
            if self._task is not None and not self._task.done():
                continue
            self._task = asyncio.ensure_future(self.check())
            stopped = asyncio.ensure_future(stop.wait())
            try:
                await asyncio.wait([self._task, stopped], return_when=asyncio.FIRST_COMPLETED)
            finally:
                stopped.cancel()

    async def close(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
