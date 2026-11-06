#!/usr/bin/env python3
"""Start the polykey sidecar from an install or a checkout.

Meant to run as `python3 -I -B -u run.py <command>`; -I (isolated mode) leaves this script's
folder off sys.path, so it is added here explicitly and nothing else is. The service starts it through
the `current` link (~/.local/share/polykey/current/sidecar/run.py); the folder added is the one the
link resolves to, so an update swapping the link never mixes two versions in this process.

When the service (`run`) fails at import or with an exception out of main(), a release that has never
reached Steam goes back to the release before it (versions.fall_back), and systemd's restart runs that one.
"""

import os
import sys
from pathlib import Path

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)


def fall_back() -> None:
    """The service could not start this release: if it never reached Steam and a release ran before it,
    go back to that one (versions.py), which the service's automatic restart then runs."""
    if sys.argv[1:2] != ["run"]:
        return
    try:
        from polykey.versions import fall_back as back

        to = back(Path(HERE).parent)
    except Exception:
        return
    if to:
        print(
            f"polykey: this release could not start; went back to {to} (updates skip it until a newer one)",
            file=sys.stderr,
            flush=True,
        )


try:
    from polykey.__main__ import main
except Exception:
    fall_back()
    raise

if __name__ == "__main__":
    try:
        main()
    except Exception:
        fall_back()
        raise
