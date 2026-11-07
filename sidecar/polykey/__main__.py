"""Command line: run.py {run,once,probe,uninstall,unpack,rollback} [options].

unpack and rollback import nothing but versions.py, so they work even when the rest of a release
does not: a release that cannot start can still be left.
"""

from __future__ import annotations

import argparse
import asyncio
import signal
import sys
from pathlib import Path
from typing import Optional

from .versions import VersionError, Versions

COMMANDS = {
    "run": "keep the keyboard injected (the systemd service runs this)",
    "once": "inject once and exit",
    "probe": "print a read-only report of the Steam objects polykey uses, and exit",
    "uninstall": "remove polykey from Steam (restores the stock keyboard) and exit",
    "unpack": "unpack a release tarball into versions/ and make it current (restart the service after)",
    "rollback": "go back to the release before this one; updates skip the one left until a newer release",
}

VERSION_COMMANDS = ("unpack", "rollback")


def forward_console(choice: Optional[bool]) -> bool:
    """Page console lines go to the journal for a dev build, or when settings.json says "console": true."""
    from . import injector, packs

    if choice is not None:
        return choice
    return injector.is_dev() or packs.read_settings(packs.user_dir() / "settings.json").get("console") is True


def _versions(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="run.py")
    parser.add_argument("command", choices=VERSION_COMMANDS)
    parser.add_argument("tarball", nargs="?", type=Path, help="unpack: the release tarball")
    parser.add_argument("--root", type=Path, help="the polykey folder (default: the one this release is in)")
    args = parser.parse_args(argv)
    if args.command == "unpack" and args.tarball is None:
        parser.error("unpack needs a release tarball")
    versions = Versions(args.root)
    try:
        if args.command == "unpack":
            print(versions.install(args.tarball), flush=True)  # only the version: install.sh reads it
        else:
            before, after = versions.rollback()
            skip = f"; updates skip {before} until a newer release" if before and before != "dev" else ""
            print(f"rolled back from {before} to {after}{skip}", flush=True)
    except VersionError as error:
        reasons = {
            "no-previous": "no earlier release to go back to",
            "bad-archive": f"{args.tarball} is not a polykey release tarball",
        }
        print(reasons.get(error.code, error.code), file=sys.stderr, flush=True)
        return 1
    except OSError as error:
        print(f"{args.command} failed: {error.strerror or type(error).__name__}", file=sys.stderr, flush=True)
        return 1
    return 0


async def _serve(cfg, log) -> None:
    from .injector import run_service

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await run_service(cfg, log, stop)


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] and argv[0] in VERSION_COMMANDS:
        sys.exit(_versions(argv))
    from .cdp import NotLoopback, check_loopback
    from .injector import Config, Log, run_once, run_probe, run_uninstall

    parser = argparse.ArgumentParser(prog="run.py", description="polykey sidecar for the Steam Frame")
    parser.add_argument("command", choices=list(COMMANDS), help="; ".join(f"{k}: {v}" for k, v in COMMANDS.items()))
    defaults = Config()
    parser.add_argument(
        "--devtools", default=defaults.devtools, help=f"debugger endpoint (default {defaults.devtools})"
    )
    parser.add_argument(
        "--bundle", type=Path, default=defaults.bundle, help=f"bundle to inject (default {defaults.bundle})"
    )
    parser.add_argument(
        "--probe-script", type=Path, default=defaults.probe, help=f"probe script (default {defaults.probe})"
    )
    parser.add_argument(
        "--console",
        action=argparse.BooleanOptionalAction,
        default=None,
        help='forward [polykey] console lines to the log (default: dev builds, or "console": true in settings.json)',
    )
    args = parser.parse_args(argv)

    log = Log()
    try:
        check_loopback(args.devtools)  # the debugger rule first: nothing is read or started before it
    except NotLoopback as error:  # exit 2 is only this; any other failure is the release's (run.py falls back)
        log.info(str(error))
        sys.exit(2)
    cfg = Config(
        devtools=args.devtools,
        bundle=args.bundle.expanduser(),
        probe=args.probe_script.expanduser(),
        forward_console=forward_console(args.console),
    )
    try:
        if args.command == "run":
            log.info(f"polykey sidecar: bundle {cfg.bundle}, debugger {cfg.devtools}")
            asyncio.run(_serve(cfg, log))
            sys.exit(0)
        runner = {"once": run_once, "probe": run_probe, "uninstall": run_uninstall}[args.command]
        sys.exit(asyncio.run(runner(cfg, log)))
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
