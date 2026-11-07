"""The installed versions of polykey, under ~/.local/share/polykey/:

  versions/<version>/  each installed release (a release tarball's contents)
  dev/                 a dev deploy (scripts/deploy.sh), marked by a DEV file
  current              the link the service runs: versions/<version> or dev
  updates/state.json   {"previous": the release that ran before this one, "skip": a release rolled
                        back from, which automatic updates leave alone until a newer one}
  updates/lock         one writer at a time: unpack, activate and rollback here, and
                        install.sh's own unpacking, each hold an exclusive flock on it

install.sh unpacks a release into versions/ and then runs `run.py activate <version>` from it, and
`run.py rollback`; the updater (updates.py) does the same in the service, with unpack(). A release
marks itself started (versions/<version>/.started) the first time it reaches Steam; one that fails
before that while it is current goes back to the release before it by itself (run.py, fall_back), and
is skipped. The running sidecar imports from its own versions/<version> (run.py resolves the link), so
swapping `current` never mixes two versions in one process: the switch takes effect when the service
restarts.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import shutil
import sys
import tarfile
import time
from pathlib import Path, PurePosixPath
from typing import Iterator, Optional

SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$")
DEV = "dev"
STARTED = ".started"  # in versions/<version>: that release has reached Steam
MAX_TOTAL = 128 << 20  # unpack(): what all the files in a release may hold together
LOCK_WAIT = 60.0  # how long a writer waits for another one to finish (install.sh waits as long)


class VersionError(Exception):
    """A short code, safe to log and to show."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def mark_started(code: Path) -> None:
    """The release in `code` (versions/<version>) reached Steam. Anything else is left alone."""
    if code.parent.name == "versions" and is_release(code.name) and not (code / STARTED).exists():
        try:
            (code / STARTED).touch()
        except OSError:
            pass


def fall_back(code: Path) -> Optional[str]:
    """The release in `code` (versions/<version>) failed to start. When it is the current release, has
    never reached Steam, and a release ran before it, go back to that one (skipping this one), say so
    on stderr and return its version. Anything else is left alone."""
    if code.parent.name != "versions" or not is_release(code.name) or (code / STARTED).exists():
        return None
    versions = Versions(code.parent.parent)
    if versions.current() != code.name or versions.previous() is None:
        return None
    to = versions.rollback()[1]
    print(
        f"polykey: this release could not start; went back to {to} (updates skip it until a newer one)",
        file=sys.stderr,
        flush=True,
    )
    return to


def app_dir() -> Path:
    """The folder this code is installed in (from versions/<version>/ or dev/), so the installer and the
    service always agree; for a checkout, ~/.local/share/polykey."""
    code = Path(__file__).resolve().parents[2]
    if code.parent.name == "versions" and is_release(code.name):
        return code.parent.parent
    if code.name == DEV and (code / "DEV").exists():
        return code.parent
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "polykey"


def parse(version: str) -> Optional[tuple]:
    """A sort key in semver precedence (build metadata is ignored), or None for a bad version."""
    match = SEMVER.match(version.split("+", 1)[0]) if isinstance(version, str) else None
    if not match:
        return None
    major, minor, patch, pre = match.groups()
    # A version without a pre-release sorts after every pre-release of it.
    tags = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split(".")) if pre else ((2, 0, ""),)
    return (int(major), int(minor), int(patch), tags)


def newer(a: str, b: str) -> bool:
    """True when release a is newer than b (a bad version is never newer)."""
    ka, kb = parse(a), parse(b)
    return ka is not None and (kb is None or ka > kb)


def is_release(version: object) -> bool:
    return isinstance(version, str) and "+" not in version and parse(version) is not None


class Versions:
    def __init__(self, root: Optional[Path] = None) -> None:
        self.root = root or app_dir()
        self.versions = self.root / "versions"
        self.dev = self.root / DEV
        self.link = self.root / "current"
        self.state_file = self.root / "updates" / "state.json"
        self.lock_file = self.root / "updates" / "lock"

    # --- reading -----------------------------------------------------------------------------------

    def installed(self) -> list[str]:
        """The releases in versions/ that look complete, oldest first."""
        found = []
        if self.versions.is_dir():
            for entry in self.versions.iterdir():
                if is_release(entry.name) and (entry / "sidecar" / "run.py").is_file():
                    found.append(entry.name)
        return sorted(found, key=parse)

    def current(self) -> Optional[str]:
        """The release `current` points at, "dev" for the dev deploy, or None."""
        try:
            target = PurePosixPath(os.readlink(self.link))
        except OSError:
            return None
        if target.parts == (DEV,):
            return DEV
        if len(target.parts) == 2 and target.parts[0] == "versions" and is_release(target.parts[1]):
            return target.parts[1]
        return None

    def state(self) -> dict:
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return (
            {k: v for k, v in data.items() if k in ("previous", "skip") and is_release(v)}
            if isinstance(data, dict)
            else {}
        )

    def skipped(self) -> Optional[str]:
        return self.state().get("skip")

    def previous(self) -> Optional[str]:
        """Where a rollback goes: the release that ran before this one; from a dev deploy, the newest release."""
        current, installed = self.current(), self.installed()
        if current == DEV or current is None:
            return installed[-1] if installed else None
        previous = self.state().get("previous")
        return previous if previous in installed and previous != current else None

    # --- changing ----------------------------------------------------------------------------------

    @contextlib.contextmanager
    def _locked(self) -> Iterator[None]:
        """Hold the lock every writer of versions/, `current` and state.json takes: the service's
        updater, `run.py activate|rollback` and install.sh. Waits up to LOCK_WAIT for another writer,
        then gives up with "busy". Blocking: in the service, run it off the loop."""
        self.lock_file.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.lock_file, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
        try:
            deadline = time.monotonic() + LOCK_WAIT
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise VersionError("busy") from None
                    time.sleep(0.05)
            yield
        finally:
            os.close(fd)  # closing it lets the lock go

    def _save_state(self, state: dict) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_file.with_name("state.json.tmp")
        tmp.write_text(json.dumps({k: v for k, v in state.items() if v}) + "\n", encoding="utf-8")
        os.replace(tmp, self.state_file)

    def _point(self, target: str) -> None:
        """Swap `current` to versions/<target> in one rename."""
        tmp = self.root / ".current.new"
        tmp.unlink(missing_ok=True)
        os.symlink(f"versions/{target}", tmp)
        os.replace(tmp, self.link)

    def activate(self, version: str, running: Optional[str] = None) -> None:
        """Make an installed release the current one (an install or an update). The release it replaces
        becomes the one a rollback goes to; one asked for by name is no longer skipped. `running`, the
        release a process still runs from until it restarts, is kept too."""
        with self._locked():
            if not is_release(version) or version not in self.installed():
                raise VersionError("not-installed")
            before, state = self.current(), self.state()
            self._point(version)
            if is_release(before) and before != version:
                state["previous"] = before
            if state.get("skip") == version:
                state.pop("skip")
            self._save_state(state)
            self._prune(running)

    def rollback(self) -> tuple[Optional[str], str]:
        """Go back to previous(); the release left is skipped by automatic updates. -> (from, to)."""
        with self._locked():
            before, target = self.current(), self.previous()
            if target is None:
                raise VersionError("no-previous")
            state = self.state()
            self._point(target)
            state["previous"] = None
            if is_release(before):
                state["skip"] = before
            self._save_state(state)
            return before, target

    def _prune(self, running: Optional[str]) -> None:
        """Keep the current release, the one before it, the one still running, and anything newer than
        current (a release rolled back from); remove the rest and leftovers of interrupted unpacks."""
        current, state = self.current(), self.state()
        keep = {current, state.get("previous"), running}
        for version in self.installed():
            if current not in (None, DEV) and newer(version, current):
                keep.add(version)
        if not self.versions.is_dir():
            return
        for entry in self.versions.iterdir():
            if entry.name not in keep and (entry.name.endswith(".new") or is_release(entry.name)):
                shutil.rmtree(entry, ignore_errors=True)

    def unpack(self, tarball: Path, version: str) -> Path:
        """Unpack a verified release tarball (polykey-<version>/… inside) into versions/<version>/.
        Only directories and regular files, under that one top folder and MAX_TOTAL bytes in all;
        tarfile's data filter keeps them inside it. Assembled beside its place and renamed in, under
        the lock (blocking: run it off the loop).
        The current release is left as it is: a process may be running from it."""
        with self._locked():
            return self._unpack(tarball, version)

    def _unpack(self, tarball: Path, version: str) -> Path:
        if not is_release(version):
            raise VersionError("bad-version")
        top = f"polykey-{version}"
        work = self.versions / f"{version}.new"
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        try:
            try:
                with tarfile.open(tarball, "r:gz") as tar:
                    members = tar.getmembers()
                    if sum(m.size for m in members) > MAX_TOTAL or not all(
                        (m.isfile() or m.isdir()) and m.name.split("/")[0] == top and ".." not in m.name.split("/")
                        for m in members
                    ):
                        raise VersionError("bad-archive")
                    tar.extractall(work, filter="data")
                if (work / top / "VERSION").read_text(encoding="utf-8").strip() != version or not (
                    work / top / "sidecar" / "run.py"
                ).is_file():
                    raise VersionError("bad-archive")
            except (tarfile.TarError, OSError, EOFError, UnicodeDecodeError):
                raise VersionError("bad-archive") from None
            final = self.versions / version
            if final.exists():
                if self.current() == version:
                    return final  # already running it: leave it be
                shutil.rmtree(final)
            os.replace(work / top, final)
            return final
        finally:
            shutil.rmtree(work, ignore_errors=True)
