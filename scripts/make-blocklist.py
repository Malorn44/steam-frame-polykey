#!/usr/bin/env python3
"""Hash a reviewed blocklist into packs/<ns>/blocked.sha256 (so the repo holds no readable slur list).

Usage: python3 scripts/make-blocklist.py LIST > packs/en/blocked.sha256
LIST: words one per line; only the [BLOCK] section is used when the file has sections; # comments.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
from polykey.lexicon import word_hash

section = "BLOCK"
hashes = set()
for raw in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("[") and line.endswith("]"):
        section = line[1:-1]
        continue
    if section == "BLOCK":
        hashes.add(word_hash(line))
print("# SHA-256 of blocked words (NFC, lower case, no possessive). See sidecar/polykey/lexicon.py.")
print("\n".join(sorted(hashes)))
