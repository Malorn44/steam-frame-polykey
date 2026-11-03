"""Command line: run.py {run,once,probe,uninstall} [options]."""
from __future__ import annotations

import argparse
import asyncio
import signal
import sys
from pathlib import Path

from .injector import Config, Log, run_once, run_probe, run_service, run_uninstall

COMMANDS = {
    "run": "keep the keyboard injected (the systemd service runs this)",
    "once": "inject once and exit",
    "probe": "print a read-only report of the Steam objects polykey uses, and exit",
    "uninstall": "remove polykey from Steam (restores the stock keyboard) and exit",
}


async def _serve(cfg: Config, log: Log) -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await run_service(cfg, log, stop)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="run.py", description="polykey sidecar for the Steam Frame")
    parser.add_argument("command", choices=list(COMMANDS), help="; ".join(f"{k}: {v}" for k, v in COMMANDS.items()))
    defaults = Config()
    parser.add_argument("--devtools", default=defaults.devtools, help=f"debugger endpoint (default {defaults.devtools})")
    parser.add_argument("--bundle", type=Path, default=defaults.bundle, help=f"bundle to inject (default {defaults.bundle})")
    parser.add_argument("--probe-script", type=Path, default=defaults.probe, help=f"probe script (default {defaults.probe})")
    parser.add_argument("--no-console", action="store_true", help="do not forward [polykey] console lines")
    args = parser.parse_args(argv)

    cfg = Config(devtools=args.devtools, bundle=args.bundle.expanduser(), probe=args.probe_script.expanduser(),
                 forward_console=not args.no_console)
    log = Log()
    try:
        if args.command == "run":
            log.info(f"polykey sidecar: bundle {cfg.bundle}, debugger {cfg.devtools}")
            asyncio.run(_serve(cfg, log))
            sys.exit(0)
        runner = {"once": run_once, "probe": run_probe, "uninstall": run_uninstall}[args.command]
        sys.exit(asyncio.run(runner(cfg, log)))
    except ValueError as error:  # e.g. a non-loopback endpoint
        log.info(str(error))
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
