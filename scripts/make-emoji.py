#!/usr/bin/env python3
"""Build packs/emoji/emoji.data (JSON) from Unicode's emoji-test.txt (Unicode License v3).

Usage: python3 scripts/make-emoji.py emoji-test.txt > packs/emoji/emoji.data
Source: https://unicode.org/Public/emoji/15.0/emoji-test.txt (15.0 matches Noto Color Emoji on the Frame).
Keeps fully-qualified emoji in Unicode's groups and order; an emoji with skin tones becomes
[base, light, medium-light, medium, medium-dark, dark] (multi-person: the same tone for each person).
"""

import json
import re
import sys

TONES = [chr(c) for c in range(0x1F3FB, 0x1F400)]
GROUP_IDS = {
    "Smileys & Emotion": "smileys",
    "People & Body": "people",
    "Animals & Nature": "animals",
    "Food & Drink": "food",
    "Travel & Places": "travel",
    "Activities": "activities",
    "Objects": "objects",
    "Symbols": "symbols",
    "Flags": "flags",
}

groups, group, order, variants = [], None, [], {}
for line in open(sys.argv[1], encoding="utf-8"):
    if line.startswith("# group: "):
        name = line[9:].strip()
        group = {"id": GROUP_IDS[name], "name": name, "items": []} if name in GROUP_IDS else None
        if group:
            groups.append(group)
        continue
    m = re.match(r"^([0-9A-F ]+?)\s*; fully-qualified\s*#\s*(\S+)", line)
    if not m or group is None:
        continue
    emoji = "".join(chr(int(cp, 16)) for cp in m.group(1).split())
    tones = {ch for ch in emoji if ch in TONES}
    if not tones:
        group["items"].append(emoji)
        continue
    if len(tones) != 1:
        continue  # mixed tones: only same-tone variants are offered
    # Match on the sequence without tones and without U+FE0F: "☝️" (261D FE0F) has tones as "261D 1F3FB".
    base = "".join(ch for ch in emoji if ch not in TONES and ch != "\ufe0f")
    variants.setdefault(base, {})[tones.pop()] = emoji

for group in groups:

    def toned(e):
        found = variants.get(e.replace("\ufe0f", ""), {})
        return [e] + [found[t] for t in TONES] if len(found) == 5 else e

    group["items"] = [toned(e) for e in group["items"]]

print(
    json.dumps(
        {
            "version": "15.0",
            "notice": "Derived from Unicode emoji-test.txt 15.0; Unicode License v3, see LICENSE.unicode",
            "groups": groups,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
)
