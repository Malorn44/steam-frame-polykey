"""Child processes for speech (pw-record, pw-dump, pw-link, the speech helper): no inherited output,
no core dumps (they hold audio), and they die with the sidecar."""

from __future__ import annotations

import asyncio
import contextlib
import ctypes
import resource
import signal
from typing import Optional

PR_SET_PDEATHSIG = 1
try:
    _LIBC: Optional[ctypes.CDLL] = ctypes.CDLL(None, use_errno=True)
except OSError:  # not on Linux
    _LIBC = None


def child_setup() -> None:
    """Runs in the child before exec: keep audio out of core dumps; SIGTERM it if the sidecar dies."""
    with contextlib.suppress(OSError, ValueError):
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if _LIBC is not None:
        _LIBC.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0)


async def spawn(
    *argv: str, stdout: bool = False, stdin: bool = False, env: Optional[dict] = None
) -> asyncio.subprocess.Process:
    pipe, devnull = asyncio.subprocess.PIPE, asyncio.subprocess.DEVNULL
    return await asyncio.create_subprocess_exec(
        *argv,
        stdin=pipe if stdin else devnull,
        stdout=asyncio.subprocess.PIPE if stdout else asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        env=env,
        preexec_fn=child_setup,
        close_fds=True,
    )


async def run(*argv: str, timeout: float, env: Optional[dict] = None) -> tuple[int, bytes]:
    """Run a short command; (exit code, stdout). -1 when it could not run or timed out."""
    try:
        proc = await spawn(*argv, stdout=True, env=env)
    except OSError:
        return -1, b""
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        await stop(proc)
        return -1, b""
    return proc.returncode if proc.returncode is not None else -1, out


async def stop(proc: Optional[asyncio.subprocess.Process], grace: float = 1.0) -> None:
    """SIGTERM, then SIGKILL after `grace` seconds."""
    if proc is None:
        return
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), grace)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
    if proc.stdout is not None:
        # Read to the end (and drop it) so the pipe closes: a full, unread buffer keeps it open.
        with contextlib.suppress(asyncio.TimeoutError, OSError):
            await asyncio.wait_for(proc.stdout.read(), 1.0)
