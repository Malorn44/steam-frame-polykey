#!/usr/bin/env python3
"""Start the polykey sidecar from an install or a checkout.

Meant to run as `python3 -I -B -u run.py <command>`; -I (isolated mode) leaves this script's
folder off sys.path, so it is added here explicitly and nothing else is. The service starts it through
the `current` link (~/.local/share/polykey/current/sidecar/run.py); the folder added is the one the
link resolves to, so an update swapping the link never mixes two versions in this process.

When the service (`run`) fails at import or with an exception out of main(), a release that has never
reached Steam goes back to the release before it (versions.fall_back), and systemd's restart runs that one.
"""

import contextlib
import os
import sys
from pathlib import Path

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)

if __name__ == "__main__":
    try:
        from polykey.__main__ import main

        main()
    except Exception:
        if sys.argv[1:2] == ["run"]:
            with contextlib.suppress(Exception):
                from polykey.versions import fall_back

                fall_back(Path(HERE).parent)
        raise
