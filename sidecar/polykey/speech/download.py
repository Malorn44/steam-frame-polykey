"""Downloads for dictation, fetched only after the user turns dictation on and asks: each file pinned by
URL, size and SHA-256, and allowed to come only from its own hosts (Hugging Face for models, GitHub for
the engine), over HTTPS, redirects included.

The file grows as `<name>.part` (0600, in a 0700 directory) and is renamed into place only once its size
and hash match. A download cut off by the network keeps its part, and the next attempt resumes it with
an HTTP Range request (hashing what is there first); a wrong size or hash removes it.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urljoin, urlsplit

import aiohttp

from . import SpeechError

HF_HOSTS = ("huggingface.co", "hf.co")  # and their subdomains (the LFS and Xet CDNs)
GITHUB_HOSTS = ("github.com", "githubusercontent.com")  # release assets redirect to *.githubusercontent.com
MAX_REDIRECTS = 5
CHUNK = 1 << 20
SPACE_MARGIN = 64 << 20
CONNECT_TIMEOUT = 15.0
READ_TIMEOUT = 30.0  # without a byte for this long, the download fails (and can resume)
CONTENT_RANGE = re.compile(r"^bytes (\d+)-(\d+)/(\d+)$")


@dataclass(frozen=True)
class Remote:
    """A pinned file: where it is, which hosts may serve it, and what it must be."""

    url: str
    size: int
    sha256: str
    hosts: tuple[str, ...]


def host_allowed(url: str, hosts: tuple[str, ...], schemes: tuple[str, ...]) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    return parts.scheme in schemes and any(host == h or host.endswith("." + h) for h in hosts)


def _hash_file(path: Path) -> "hashlib._Hash":
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            digest.update(block)
    return digest


class Download:
    """One download of `remote` to `path`; progress in `done` / `total`, failure in `error`."""

    def __init__(
        self,
        remote: Remote,
        path: Path,
        schemes: tuple[str, ...] = ("https",),
        on_progress: Optional[Callable[[], None]] = None,
    ) -> None:
        self.remote = remote
        self.path = path
        self.schemes = schemes
        self.on_progress = on_progress or (lambda: None)
        self.done = 0
        self.total = remote.size
        self.error: Optional[str] = None

    @property
    def part(self) -> Path:
        return self.path.with_name(self.path.name + ".part")

    async def run(self) -> bool:
        """Download and verify; True when the file is in place. Errors are codes in `error`."""
        keep = False  # a part cut off by the network is kept, to resume
        try:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            have = self.part.stat().st_size if self.part.exists() else 0
            if shutil.disk_usage(self.path.parent).free < self.remote.size - have + SPACE_MARGIN:
                raise SpeechError("no-space")
            timeout = aiohttp.ClientTimeout(total=None, connect=CONNECT_TIMEOUT, sock_read=READ_TIMEOUT)
            async with aiohttp.ClientSession(timeout=timeout) as http:
                await self._fetch(http)
            os.replace(self.part, self.path)
            return True
        except SpeechError as error:
            self.error = error.code
            keep = error.code == "network"
        except asyncio.CancelledError:
            self.error = "cancelled"  # turned off or deleted: nothing is kept
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError):
            self.error = "network"
            keep = True
        except OSError:
            self.error = "disk"
        finally:
            if not keep:
                with contextlib.suppress(OSError):
                    self.part.unlink()
            self.on_progress()
        return False

    async def _fetch(self, http: aiohttp.ClientSession) -> None:
        loop = asyncio.get_running_loop()
        have = self.part.stat().st_size if self.part.exists() else 0
        if have > self.remote.size:
            self.part.unlink()
            have = 0
        # Hashing a large part takes a while: off the event loop.
        digest = await loop.run_in_executor(None, _hash_file, self.part) if have else hashlib.sha256()
        self.done = have
        if have == self.remote.size:
            return self._verify(digest)
        url = self.remote.url
        headers = {"Range": f"bytes={have}-"} if have else {}
        for _ in range(MAX_REDIRECTS + 1):
            if not host_allowed(url, self.remote.hosts, self.schemes):
                raise SpeechError("bad-host")
            async with http.get(url, allow_redirects=False, headers=headers) as response:
                if response.status in (301, 302, 303, 307, 308):
                    url = urljoin(url, response.headers.get("Location", ""))
                    continue
                if response.status == 206 and have:
                    match = CONTENT_RANGE.match(response.headers.get("Content-Range", ""))
                    if not match or int(match.group(1)) != have or int(match.group(3)) != self.remote.size:
                        raise SpeechError("bad-size")
                elif response.status == 200:
                    have, digest, self.done = 0, hashlib.sha256(), 0  # no range support: from the start
                else:
                    raise SpeechError("network")
                if response.content_length not in (None, self.remote.size - have):
                    raise SpeechError("bad-size")
                await self._save(response, digest, append=have > 0)
                return self._verify(digest)
        raise SpeechError("network")

    async def _save(self, response: aiohttp.ClientResponse, digest, append: bool) -> None:
        size = self.remote.size
        reported = self.done * 100 // size
        flags = os.O_WRONLY | os.O_CREAT | (os.O_APPEND if append else os.O_TRUNC)
        fd = os.open(self.part, flags, 0o600)
        with os.fdopen(fd, "ab" if append else "wb") as out:
            async for chunk in response.content.iter_chunked(CHUNK):
                self.done += len(chunk)
                if self.done > size:
                    raise SpeechError("bad-size")
                digest.update(chunk)
                out.write(chunk)
                if self.done * 100 // size != reported:
                    reported = self.done * 100 // size
                    self.on_progress()

    def _verify(self, digest) -> None:
        if self.done != self.remote.size:
            raise SpeechError("network")  # cut short: the part is kept and resumes
        if digest.hexdigest() != self.remote.sha256:
            raise SpeechError("bad-hash")
