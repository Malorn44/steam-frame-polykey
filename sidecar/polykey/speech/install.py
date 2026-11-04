"""The speech engine, transcribe.cpp, installed from its own release on GitHub: the prebuilt native
libraries for this machine and the ctypes binding, both pinned by size and SHA-256 in catalog.json.
Nothing is compiled. It goes to ~/.local/share/polykey/speech/engine/<version>/:

  lib/       libtranscribe.so, ggml and its CPU variants (ggml loads the best one this CPU supports),
             contract.json; never the Vulkan backend, so the GPU is never used
  python/    transcribe_cpp/ (the binding's .py files only, from its wheel)
  licenses/  the release's licence files

Unpacking takes only regular files with plain names, so an archive cannot write anywhere else. The
directory is assembled beside its final place and renamed into it; older versions are removed.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import platform
import re
import shutil
import tarfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Callable, Optional

from . import SpeechError
from .catalog import Engine
from .download import Download

LIB = re.compile(r"^lib[A-Za-z0-9_.+-]+\.so$")
SKIP = ("libggml-vulkan.so",)  # CPU only: GPU inference on the Frame drew about 17 W and crashed
PY = re.compile(r"^transcribe_cpp/([A-Za-z0-9_]+\.py|py\.typed)$")
PART = re.compile(r"^[A-Za-z0-9_.-]+$")
MAX_MEMBER = 64 << 20
REQUIRED = ("libtranscribe.so", "libggml.so", "libggml-base.so")


def engine_dir(home: Path, version: str) -> Path:
    return home / "engine" / version


def installed(home: Path, version: str) -> bool:
    directory = engine_dir(home, version)
    return (directory / "lib" / "libtranscribe.so").is_file() and (directory / "python" / "transcribe_cpp" / "__init__.py").is_file()


def _copy(source, dest: Path, size: int) -> None:
    if size > MAX_MEMBER:
        raise SpeechError("bad-archive")
    with open(dest, "wb") as out:
        shutil.copyfileobj(source, out)


def unpack(native: Path, wheel: Path, target: Path, version: str) -> None:
    """Assemble the engine directory from the two verified downloads (blocking: run it off the loop)."""
    work = target.with_name(target.name + ".new")
    shutil.rmtree(work, ignore_errors=True)
    for sub in ("lib", "python/transcribe_cpp", "licenses"):
        (work / sub).mkdir(parents=True)
    with tarfile.open(native, "r:gz") as tar:
        for member in tar.getmembers():
            parts = PurePosixPath(member.name).parts
            if not member.isfile() or len(parts) < 2 or not all(PART.match(p) for p in parts):
                continue
            name = parts[-1]
            if len(parts) == 2 and ((LIB.match(name) and name not in SKIP) or name == "contract.json"):
                dest = work / "lib" / name
            elif parts[1] == "licenses" and name == "LICENSE":
                dest = work / "licenses" / (parts[-2] if len(parts) > 3 else "transcribe.cpp")  # ggml, miniz, …
            else:
                continue
            source = tar.extractfile(member)
            if source is not None:
                _copy(source, dest, member.size)
    with zipfile.ZipFile(wheel) as whl:
        for info in whl.infolist():
            if PY.match(info.filename):
                with whl.open(info) as source:
                    _copy(source, work / "python" / info.filename, info.file_size)
            elif info.filename.endswith(".dist-info/licenses/LICENSE"):
                with whl.open(info) as source:
                    _copy(source, work / "licenses" / "transcribe_cpp", info.file_size)
    lib = work / "lib"
    contract = json.loads((lib / "contract.json").read_text(encoding="utf-8")) if (lib / "contract.json").is_file() else {}
    if (not all((lib / name).is_file() for name in REQUIRED) or not any(lib.glob("libggml-cpu*.so"))
            or not (work / "python" / "transcribe_cpp" / "__init__.py").is_file() or contract.get("version") != version):
        shutil.rmtree(work, ignore_errors=True)
        raise SpeechError("bad-archive")
    shutil.rmtree(target, ignore_errors=True)
    work.rename(target)


class EngineDownload:
    """Download and install the engine; progress in `done` / `total` (both files), failure in `error`."""

    def __init__(self, engine: Engine, home: Path, machine: Optional[str] = None, schemes: tuple[str, ...] = ("https",),
                 on_progress: Optional[Callable[[], None]] = None) -> None:
        self.engine = engine
        self.home = home
        self.native = engine.native.get(machine or platform.machine())
        self.schemes = schemes
        self.on_progress = on_progress or (lambda: None)
        self.error: Optional[str] = None
        self._jobs: list[Download] = []
        self.total = (self.native.size if self.native else 0) + engine.python.size

    @property
    def done(self) -> int:
        return sum(job.done for job in self._jobs)

    async def run(self) -> bool:
        if self.native is None:
            self.error = "unsupported"
            self.on_progress()
            return False
        staging = self.home / "engine" / ".download"
        files = []
        for remote in (self.native, self.engine.python):
            job = Download(remote, staging / remote.url.rsplit("/", 1)[-1], self.schemes, self.on_progress)
            self._jobs.append(job)
            if not await job.run():
                self.error = job.error
                return False
            files.append(job.path)
        target = engine_dir(self.home, self.engine.version)
        try:
            await asyncio.get_running_loop().run_in_executor(None, unpack, files[0], files[1], target, self.engine.version)
        except SpeechError as error:
            self.error = error.code
        except (OSError, tarfile.TarError, zipfile.BadZipFile, ValueError, EOFError):
            self.error = "bad-archive"
        finally:
            shutil.rmtree(staging, ignore_errors=True)
            self.on_progress()
        if self.error:
            return False
        for other in (self.home / "engine").iterdir():  # an older version
            if other != target and other.is_dir():
                with contextlib.suppress(OSError):
                    shutil.rmtree(other)
        return True
