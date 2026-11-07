"""Keep polykey's bundle injected into Steam's SharedJSContext (loopback debugger, 127.0.0.1:8080).

Event-driven: re-checks on new execution contexts (debounced), with a slow safety check; reconnects
with backoff when Steam restarts. On stop it calls __polykey.uninstall(). Forwards "[polykey]"
console lines to the journal when asked (Config.forward_console: a dev build, by default).
The service also runs the updater (updates.py), and tells it whether the keyboard is on screen.
A polykey of another version found in the page is replaced with ours.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Optional, TextIO

import aiohttp

from .anthy import Converter
from . import packs as pack_loader
from .bridge import BINDING_NAME, Bridge, reply_expression
from .cdp import CdpError, CdpSession, check_loopback, find_target, list_targets
from .desktop import DesktopPaste
from .lexicon import Lexicons
from .speech.session import Dictation
from .updates import Updater
from .versions import mark_started

TARGET_TITLE = "SharedJSContext"
LOG_PREFIX = "[polykey]"
SOURCE_URL = "polykey/bundle.js"

# The version of the polykey running in the page, or false when there is none.
CHECK_EXPRESSION = (
    "(() => { const p = globalThis.__polykey;"
    " return typeof p === 'object' && p !== null && p.state !== 'uninstalled' && String(p.version); })()"
)
STATUS_EXPRESSION = "(() => { const p = globalThis.__polykey; return p ? `${p.version} (${p.state})` : 'missing'; })()"
# Whether polykey's keyboard is on screen: "open", "hidden" or "unknown", and nothing else leaves the
# page. A polykey that is not running draws no keyboard; a running one has the VR keyboard's open flag
# in its status line (debug.status(): "running keyboard=… open=true mode=…").
KEYBOARD_EXPRESSION = (
    "(() => { const p = globalThis.__polykey;"
    " if (typeof p !== 'object' || p === null || p.state !== 'running') return 'hidden';"
    " try { const m = / open=(true|false) /.exec(String(p.debug.status()));"
    " return m ? (m[1] === 'true' ? 'open' : 'hidden') : 'unknown'; } catch (e) { return 'unknown'; } })()"
)
UNINSTALL_EXPRESSION = (
    "(() => { const p = globalThis.__polykey;"
    " if (p && typeof p.uninstall === 'function') { p.uninstall(); return true; } return false; })()"
)

# The version this code is in: ~/.local/share/polykey/versions/<version> or dev, or a checkout.
INSTALL_DIR = Path(__file__).resolve().parents[2]


def _default(name: str) -> Path:
    """An installed file (versions/<version>/<name>), or the build output in a checkout."""
    installed = INSTALL_DIR / name
    staged = INSTALL_DIR / "dist" / "stage" / name
    return staged if not installed.exists() and staged.exists() else installed


def is_dev() -> bool:
    """A dev deploy (its DEV marker) or a checkout (no VERSION of its own), as opposed to a release."""
    return (INSTALL_DIR / "DEV").exists() or not (INSTALL_DIR / "VERSION").is_file()


def installed_version() -> str:
    try:
        return _default("VERSION").read_text(encoding="utf-8").strip() or "unknown"
    except OSError:
        return "unknown"


@dataclass
class Config:
    devtools: str = "http://127.0.0.1:8080"
    bundle: Path = field(default_factory=lambda: _default("bundle.js"))
    probe: Path = field(default_factory=lambda: _default("probe.js"))
    packs: Path = field(default_factory=lambda: _default("packs"))
    schema: Path = field(default_factory=lambda: _default("packs/pack.schema.json"))
    user_dir: Path = field(default_factory=pack_loader.user_dir)
    forward_console: bool = False
    debounce: float = 1.0
    safety_check: float = 120.0
    backoff_start: float = 2.0
    backoff_max: float = 30.0
    call_timeout: float = 15.0
    uninstall_timeout: float = 2.0
    # Desktop Mode paste route; socket None = $XDG_RUNTIME_DIR/nested_plasma/wayland-0.
    desktop_paste: bool = True
    desktop_socket: Optional[Path] = None
    focus_display: str = ":0"


class Log:
    """Concise lines for the journal; repeated state lines are printed once."""

    def __init__(self, stream: Optional[TextIO] = None) -> None:
        self._stream = stream
        self._last_state: Optional[str] = None

    def info(self, message: str) -> None:
        print(message, file=self._stream or sys.stdout, flush=True)

    def state(self, message: str) -> None:
        if message != self._last_state:
            self._last_state = message
            self.info(message)

    def clear_state(self) -> None:
        self._last_state = None


async def wait_any(*awaitables: Awaitable, timeout: float) -> None:
    """Return when the first awaitable finishes or the timeout passes; cancel the rest."""
    tasks = [asyncio.ensure_future(a) for a in awaitables]
    try:
        await asyncio.wait(tasks, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def sleep_unless(stop: asyncio.Event, seconds: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), seconds)
    except asyncio.TimeoutError:
        pass


def read_bundle(path: Path, log: Log) -> Optional[str]:
    try:
        source = path.read_text(encoding="utf-8")
    except OSError as error:
        log.state(f"cannot read bundle {path}: {error.strerror or type(error).__name__}")
        return None
    return f"{source}\n//# sourceURL={SOURCE_URL}\n"


def boot_script(cfg: Config, log: Log) -> str:
    """Packs and settings for the page, set before the bundle runs. Re-read on every injection."""
    boot = pack_loader.load(cfg.packs, cfg.schema, cfg.user_dir)
    for error in boot["errors"]:
        log.info(f"pack: {error}")
    return f"globalThis.__polykeyBoot = {json.dumps(boot, ensure_ascii=True)};\n"


async def inject(session: CdpSession, cfg: Config, log: Log) -> bool:
    path = cfg.bundle
    source = read_bundle(path, log)
    if source is None:
        return False
    try:
        await session.evaluate(boot_script(cfg, log) + source)
    except (CdpError, asyncio.TimeoutError) as error:
        log.info(f"injection failed: {type(error).__name__}: {error}")
        return False
    try:
        status = await session.evaluate(STATUS_EXPRESSION)
    except (CdpError, asyncio.TimeoutError):
        status = "?"
    log.info(f"injected {path.name} -> {status}")
    mark_started(INSTALL_DIR)  # this release has reached Steam
    return True


def bundle_version(bundle: Path) -> Optional[str]:
    """The version of the bundle we inject (its build's VERSION file), if it has one."""
    try:
        return (bundle.parent / "VERSION").read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


async def ensure_injected(session: CdpSession, cfg: Config, log: Log) -> bool:
    try:
        running = await session.evaluate(CHECK_EXPRESSION)
    except (CdpError, asyncio.TimeoutError) as error:
        log.state(f"check failed ({type(error).__name__})")
        return False
    if isinstance(running, str):
        wanted = bundle_version(cfg.bundle)
        if wanted is None or running == wanted:
            return True
        # Another version is in the page (an update whose old sidecar could not remove it): replace it.
        # Any script in the page can set __polykey.version, so only ours reaches the journal.
        log.info(f"another polykey is in Steam; injecting {wanted}")
    return await inject(session, cfg, log)


async def uninstall_in_page(session: CdpSession, log: Log, timeout: float) -> None:
    try:
        removed = await asyncio.wait_for(session.evaluate(UNINSTALL_EXPRESSION), timeout)
        log.info("removed from Steam; stock keyboard restored" if removed else "nothing to remove from Steam")
    except (CdpError, asyncio.TimeoutError) as error:
        log.info(f"could not remove from Steam ({type(error).__name__}); restarting Steam restores the stock keyboard")


class Page:
    """The SharedJSContext connection while there is one, so the updater can ask whether the keyboard is
    on screen before it restarts the service."""

    def __init__(self) -> None:
        self.session: Optional[CdpSession] = None

    async def keyboard_hidden(self) -> bool:
        """True when a restart cannot interrupt typing: polykey's keyboard is not on screen, or there is
        no Steam page to show it. False while it is open, or when the page cannot tell."""
        session = self.session
        if session is None or session.closed:
            return True
        try:
            return await session.evaluate(KEYBOARD_EXPRESSION) == "hidden"
        except (CdpError, asyncio.TimeoutError):
            return False


class Watch:
    """CDP events for one connection: reload detection, console forwarding, bridge calls."""

    def __init__(self, cfg: Config, log: Log, bridge: Optional[Bridge] = None) -> None:
        self._cfg = cfg
        self._log = log
        self._bridge = bridge
        self._connected_ms = time.time() * 1000
        self._tasks: set[asyncio.Future] = set()
        self.session: Optional[CdpSession] = None
        self.recheck = asyncio.Event()

    def on_event(self, method: str, params: dict) -> None:
        if method in ("Runtime.executionContextCreated", "Runtime.executionContextsCleared"):
            self.recheck.set()
        elif method == "Runtime.consoleAPICalled":
            self._on_console(params)
        elif method == "Runtime.bindingCalled" and params.get("name") == BINDING_NAME and self._bridge is not None:
            task = asyncio.ensure_future(self._serve_bridge(params))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _serve_bridge(self, params: dict) -> None:
        """Answer one polykeyBridge(...) call. The payload may hold typed text: never log it."""
        assert self._bridge is not None
        reply = await self._bridge.handle(str(params.get("payload", "")))
        out = {"expression": reply_expression(reply)}
        if isinstance(params.get("executionContextId"), int):
            out["contextId"] = params["executionContextId"]
        try:
            if self.session is not None:
                await self.session.call("Runtime.evaluate", out)
        except (CdpError, asyncio.TimeoutError):
            pass

    def cancel_tasks(self) -> None:
        for task in self._tasks:
            task.cancel()

    def _on_console(self, params: dict) -> None:
        # Runtime.enable replays old messages; only lines logged after we connected count.
        if params.get("timestamp", 0) < self._connected_ms - 1000:
            return
        args = params.get("args") or []
        first = args[0].get("value") if args and isinstance(args[0], dict) else None
        if first != LOG_PREFIX and not (isinstance(first, str) and first.startswith(LOG_PREFIX + " ")):
            return
        if not self._cfg.forward_console:
            return
        parts = []
        for arg in args:
            if not isinstance(arg, dict):
                continue
            if "value" in arg:
                value = arg["value"]
                parts.append(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))
            else:
                parts.append(str(arg.get("description") or arg.get("type") or "?").splitlines()[0])
        text = " ".join(parts)[len(LOG_PREFIX) :].strip()
        level = params.get("type", "log")
        self._log.info(f"page: {text}" if level == "log" else f"page {level}: {text}")


async def watch_target(
    http: aiohttp.ClientSession,
    target: dict,
    cfg: Config,
    log: Log,
    stop: asyncio.Event,
    bridge: Optional[Bridge] = None,
    page: Optional[Page] = None,
) -> None:
    """Keep the bundle injected into one target until its websocket closes or we are stopped."""
    ws = await http.ws_connect(target["webSocketDebuggerUrl"], max_msg_size=0)
    watch = Watch(cfg, log, bridge)
    session = CdpSession(ws, on_event=watch.on_event, call_timeout=cfg.call_timeout)
    watch.session = session
    if page is not None:
        page.session = session
    log.clear_state()
    log.info(f"connected to {TARGET_TITLE}")
    try:
        await session.call("Runtime.enable")
        if bridge is not None:
            # Lasts for this connection and reaches contexts created by later reloads.
            await session.call("Runtime.addBinding", {"name": BINDING_NAME})
        while not session.closed and not stop.is_set():
            watch.recheck.clear()
            await ensure_injected(session, cfg, log)
            await wait_any(watch.recheck.wait(), stop.wait(), session.wait_closed(), timeout=cfg.safety_check)
            if watch.recheck.is_set() and not stop.is_set():
                await sleep_unless(stop, cfg.debounce)  # contexts arrive in bursts
        if stop.is_set() and not session.closed:
            await uninstall_in_page(session, log, cfg.uninstall_timeout)
    except (CdpError, asyncio.TimeoutError) as error:
        log.info(f"connection problem ({type(error).__name__}); reconnecting")
    finally:
        if page is not None and page.session is session:
            page.session = None
        watch.cancel_tasks()
        await session.close()
    if not stop.is_set():
        log.info(f"{TARGET_TITLE} connection closed; reconnecting")


async def run_service(cfg: Config, log: Log, stop: asyncio.Event) -> None:
    check_loopback(cfg.devtools)
    desktop = DesktopPaste(cfg.desktop_socket, cfg.focus_display) if cfg.desktop_paste else None
    settings = cfg.user_dir / "settings.json"
    dictation = Dictation(log, settings)  # nothing is recorded or loaded until dictation is used
    dictation.startup()
    page = Page()
    updates = Updater(
        log,
        settings,
        installed_version(),
        is_dev(),
        INSTALL_DIR / "allowed_signers",
        keyboard_hidden=page.keyboard_hidden,
    )
    checks = asyncio.ensure_future(updates.run(stop))
    bridge = Bridge(
        log,
        desktop,
        Lexicons([cfg.user_dir / "packs", cfg.packs]),
        settings,
        Converter(),
        dictation=dictation,
        updates=updates,
    )
    try:
        await _serve_forever(cfg, log, stop, bridge, page)
    finally:
        checks.cancel()
        await updates.close()
        await dictation.close()  # stops the recorder and the speech helper
        if desktop is not None:
            await desktop.restore()  # never leave typed text on the desktop clipboard
            desktop.clipboard.close()


async def _serve_forever(
    cfg: Config, log: Log, stop: asyncio.Event, bridge: Bridge, page: Optional[Page] = None
) -> None:
    backoff = cfg.backoff_start
    timeout = aiohttp.ClientTimeout(total=None, connect=5, sock_read=None)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        while not stop.is_set():
            try:
                target = find_target(await asyncio.wait_for(list_targets(http, cfg.devtools), 10), TARGET_TITLE)
                if target is not None:
                    backoff = cfg.backoff_start
                    started = asyncio.get_running_loop().time()
                    await watch_target(http, target, cfg, log, stop, bridge, page)
                    if asyncio.get_running_loop().time() - started < 1.0:
                        await sleep_unless(stop, cfg.backoff_start)  # never spin on a flapping target
                    continue
                log.state(f"waiting for the {TARGET_TITLE} target")
            except (aiohttp.ClientError, asyncio.TimeoutError, CdpError, OSError, ValueError) as error:
                log.state(f"debugger unavailable at {cfg.devtools} ({type(error).__name__}); retrying")
            await sleep_unless(stop, backoff)
            backoff = min(backoff * 2, cfg.backoff_max)


async def _with_session(cfg: Config, log: Log, action) -> int:
    """Connect once to SharedJSContext, run `action(session)`, and return its exit code."""
    check_loopback(cfg.devtools)
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as http:
        try:
            target = find_target(await list_targets(http, cfg.devtools), TARGET_TITLE)
            if target is None:
                log.info(f"no {TARGET_TITLE} target at {cfg.devtools}")
                return 1
            ws = await http.ws_connect(target["webSocketDebuggerUrl"], max_msg_size=0)
            session = CdpSession(ws, call_timeout=cfg.call_timeout)
            try:
                return await action(session, http)
            finally:
                await session.close()
        except (aiohttp.ClientError, asyncio.TimeoutError, CdpError, OSError, ValueError) as error:
            log.info(f"debugger unavailable at {cfg.devtools}: {type(error).__name__}: {error}")
            return 1


async def run_once(cfg: Config, log: Log) -> int:
    """Inject once, unconditionally; the bundle replaces a running instance itself."""

    async def action(session: CdpSession, _http) -> int:
        return 0 if await inject(session, cfg, log) else 1

    return await _with_session(cfg, log, action)


async def run_uninstall(cfg: Config, log: Log) -> int:
    async def action(session: CdpSession, _http) -> int:
        await uninstall_in_page(session, log, cfg.uninstall_timeout)
        return 0

    return await _with_session(cfg, log, action)


async def run_probe(cfg: Config, log: Log) -> int:
    """Print a read-only report of the Steam objects polykey relies on, and the target list."""
    try:
        probe = cfg.probe.read_text(encoding="utf-8")
    except OSError as error:
        log.info(f"cannot read probe {cfg.probe}: {error.strerror or type(error).__name__}")
        return 1

    async def action(session: CdpSession, http) -> int:
        report = await session.evaluate(f"(() => {{ {probe}\n; return JSON.stringify(__polykeyProbe.report()); }})()")
        data = json.loads(report) if isinstance(report, str) else report
        titles = [t.get("title") for t in await list_targets(http, cfg.devtools) if isinstance(t, dict)]
        log.info(json.dumps({"steam": data, "targets": titles}, ensure_ascii=False, indent=2))
        return 0 if isinstance(data, dict) and not data.get("missing") else 2

    return await _with_session(cfg, log, action)
