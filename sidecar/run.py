#!/usr/bin/env python3
"""Start the polykey sidecar from an install or a checkout.

Meant to run as `python3 -I -B -u run.py <command>`; -I (isolated mode) leaves this script's
folder off sys.path, so it is added here explicitly and nothing else is.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from polykey.__main__ import main

if __name__ == "__main__":
    main()
