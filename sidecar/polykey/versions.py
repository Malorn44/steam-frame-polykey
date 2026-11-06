"""The installed versions of polykey, under ~/.local/share/polykey/:

  versions/<version>/  each installed release (a release tarball's contents)
  dev/                 a dev deploy (scripts/deploy.sh), marked by a DEV file
  current              the link the service runs: versions/<version> or dev
  updates/state.json   {"previous": the release that ran before this one, "skip": a release rolled
                        back from, which automatic updates leave alone until a newer one}

install.sh unpacks a release into versions/ and then runs `run.py activate <version>` from it, and
`run.py rollback`; unpack() does the same unpacking in Python, for the service. The running sidecar
imports from its own versions/<version> (run.py resolves the link), so swapping `current` never
mixes two versions in one process: the switch takes effect when the service restarts.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tarfile
from pathlib import Path, PurePosixPath
from typing import Optional

SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$")
DEV = "dev"
MAX_MEMBER = 32 << 20  # unpack(): the largest file a release may hold, and all of them together
MAX_TOTAL = 128 << 20
PART = re.compile(r"^[A-Za-z0-9_.+@-]+$")  # unpack(): what a path part in a release may be


class VersionError(Exception):
    """A short code, safe to log and to show."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def app_dir() -> Path:
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

    def _save_state(self, state: dict) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_file.with_name("state.json.tmp")
        tmp.write_text(json.dumps({k: v for k, v in state.items() if v}) + "\n", encoding="utf-8")
        os.replace(tmp, self.state_file)

    def _point(self, target: str) -> None:
        """Swap `current` to versions/<target> (or dev) in one rename."""
        relative = DEV if target == DEV else f"versions/{target}"
        tmp = self.root / ".current.new"
        tmp.unlink(missing_ok=True)
        os.symlink(relative, tmp)
        os.replace(tmp, self.link)

    def activate(self, version: str, running: Optional[str] = None) -> None:
        """Make an installed release the current one (an install or an update). The release it replaces
        becomes the one a rollback goes to; one asked for by name is no longer skipped. `running`, the
        release a process still runs from until it restarts, is kept too."""
        if not is_release(version) or version not in self.installed():
            raise VersionError("not-installed")
        before, state = self.current(), self.state()
        self._point(version)
        if is_release(before) and before != version:
            state["previous"] = before
        if state.get("skip") == version:
            state.pop("skip")
        self._save_state(state)
        self.prune(running)

    def rollback(self) -> tuple[Optional[str], str]:
        """Go back to previous(); the release left is skipped by automatic updates. -> (from, to)."""
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

    def prune(self, running: Optional[str] = None) -> None:
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
        Only directories and regular files with plain names, under that one top folder; nothing can
        land anywhere else. Assembled beside its place and renamed in (blocking: run it off the loop).
        The current release is left as it is: a process may be running from it."""
        if not is_release(version):
            raise VersionError("bad-version")
        top = f"polykey-{version}"
        work = self.versions / f"{version}.new"
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        total = 0
        try:
            with tarfile.open(tarball, "r:gz") as tar:
                for member in tar:
                    parts = PurePosixPath(member.name).parts
                    if not parts or parts[0] != top or not all(PART.match(p) and p not in (".", "..") for p in parts):
                        raise VersionError("bad-archive")
                    dest = work.joinpath(*parts[1:])
                    if member.isdir():
                        dest.mkdir(parents=True, exist_ok=True)
                        continue
                    if not member.isfile() or member.size > MAX_MEMBER or len(parts) < 2:
                        raise VersionError("bad-archive")
                    total += member.size
                    if total > MAX_TOTAL:
                        raise VersionError("bad-archive")
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    source = tar.extractfile(member)
                    if source is None:
                        raise VersionError("bad-archive")
                    with source, open(dest, "wb") as out:
                        shutil.copyfileobj(source, out)
                    os.chmod(dest, 0o755 if member.mode & 0o100 else 0o644)
            if (work / "VERSION").read_text(encoding="utf-8").strip() != version or not (
                work / "sidecar" / "run.py"
            ).is_file():
                raise VersionError("bad-archive")
        except (tarfile.TarError, OSError, EOFError, UnicodeDecodeError):
            shutil.rmtree(work, ignore_errors=True)
            raise VersionError("bad-archive") from None
        except VersionError:
            shutil.rmtree(work, ignore_errors=True)
            raise
        final = self.versions / version
        if final.exists():
            if self.current() == version:
                shutil.rmtree(work, ignore_errors=True)  # already running it: leave it be
                return final
            shutil.rmtree(final)
        os.replace(work, final)
        return final
