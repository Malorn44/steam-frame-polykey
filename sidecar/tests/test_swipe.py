from __future__ import annotations

import asyncio
import itertools
import json
import math
import random
import time
from pathlib import Path

from polykey.bridge import Bridge
from polykey.injector import Log
from polykey.lexicon import Lexicon, Lexicons
from polykey.swipe import GeometricDecoder, Swipe, fold, resample

ROOT = Path(__file__).resolve().parents[2]


def qwerty(width: float = 854, height: float = 200) -> tuple[dict[str, tuple[float, float]], float]:
    """The letter keys' centres of the bundled en/qwerty layout drawn width × height px, as the page sends them."""
    layout = json.loads((ROOT / "packs/en/qwerty.json").read_text(encoding="utf-8"))
    row_height = height / len(layout["rows"])
    centres: dict[str, tuple[float, float]] = {}
    key_width = 0.0
    for r, row in enumerate(layout["rows"]):
        keys = [k if isinstance(k, dict) else {"type": "char", "char": k} for k in row]
        units = sum(k.get("w", 1) for k in keys)
        x = 0.0
        for key in keys:
            w = key.get("w", 1) * width / units
            if key["type"] == "char" and key["char"].isalpha():
                centres[key["char"]] = (x + w / 2, r * row_height + row_height / 2)
                key_width = w
            x += w
    return centres, key_width


KEYS, KEY_WIDTH = qwerty()
LEXICON = Lexicons([ROOT / "packs"]).get("en/words")


def traced(word: str, rng: random.Random | None = None, noise: float = 0.0) -> list[tuple[float, float]]:
    """A swipe through the word's keys: straight between them, each key landed on with some error, and
    sampled every few px as the laser reports it."""
    keys = fold(word, frozenset(KEYS))
    corners = [
        (
            KEYS[k][0] + (rng.gauss(0, noise) * KEY_WIDTH if rng else 0),
            KEYS[k][1] + (rng.gauss(0, noise * 0.7) * KEY_WIDTH if rng else 0),
        )
        for k in keys
    ]
    points = []
    for (x0, y0), (x1, y1) in itertools.pairwise(corners):
        steps = max(2, int(math.dist((x0, y0), (x1, y1)) / 6))
        points += [(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps) for i in range(steps)]
    return points + [corners[-1]]


def decode(path, limit=5, decoder=None):
    return (decoder or DECODER).decode("en/words", LEXICON.counts(), resample(path, 64), KEYS, KEY_WIDTH, limit)


DECODER = GeometricDecoder()


def test_folds_words_onto_the_keys():
    letters = frozenset("abcdefghijklmnopqrstuvwxyz")
    assert fold("hello", letters) == "helo"  # a doubled letter is one key
    assert fold("don't", letters) == "dont"
    assert fold("café", letters) == "cafe"  # an accent on its base letter
    assert fold("Paris", letters) == "paris"
    assert fold("naïve", frozenset("naive")) == "naive"
    assert fold("ñu", frozenset("u")) is None  # no key for n


def test_resample_spaces_points_evenly():
    assert resample([(0, 0), (10, 0), (10, 10)], 5) == [(0, 0), (5, 0), (10, 0), (10, 5), (10, 10)]
    assert resample([(3, 3)], 3) == [(3, 3)] * 3
    assert resample([(0, 0), (0, 0), (4, 0)], 3) == [(0, 0), (2, 0), (4, 0)]


def test_a_word_traced_through_its_keys_ranks_first():
    for word in [
        "hello",
        "world",
        "the",
        "keyboard",
        "swipe",
        "quick",
        "brown",
        "jumps",
        "about",
        "people",
        "because",
        "question",
        "would",
        "great",
    ]:
        assert decode(traced(word))[0] == word, word
    # Some words share one path: typing and topping both run straight along the top row (t y u i o p), so
    # the commoner wins and the other is offered.
    assert "typing" in decode(traced("typing"))[:3]


def test_most_sloppy_swipes_still_rank_first_or_close():
    rng = random.Random(7)
    counts = LEXICON.counts()
    pool = [
        w
        for w in sorted(counts, key=counts.get, reverse=True)[50:3000]
        if w.isalpha() and w.islower() and len(fold(w, frozenset(KEYS))) >= 3
    ]
    words = rng.sample(pool, 100)
    top1 = top3 = 0
    for word in words:
        found = [w.lower() for w in decode(traced(word, rng, noise=0.2), limit=3)]
        top1 += found[:1] == [word]
        top3 += word in found
    assert top1 >= 75 and top3 >= 90, (top1, top3)


def test_frequency_breaks_ties_between_words_with_one_path():
    # to and too swipe alike (doubles are one key): the commoner first, the other offered.
    found = decode(traced("to"))
    assert found[0] == "to" and "too" in found


def test_prunes_by_the_first_and_last_keys():
    found = decode(traced("hello"), limit=8)
    assert all(fold(w, frozenset(KEYS))[0] in "hgjyubn" for w in found)  # near where it started
    assert all(fold(w, frozenset(KEYS))[-1] in "oiplk9" for w in found)  # near where it ended


def test_one_spelling_per_word_and_the_lists_own_case():
    lexicon = Lexicon.parse("help\t200\nHelp\t50\nParis\t150\npairs\t100\n")
    decoder = GeometricDecoder()
    found = decoder.decode("t/w", lexicon.counts(), resample(traced("help"), 64), KEYS, KEY_WIDTH, 5)
    assert found == ["help"]
    found = decoder.decode("t/w", lexicon.counts(), resample(traced("paris"), 64), KEYS, KEY_WIDTH, 5)
    assert found[0] == "Paris"


def test_scale_does_not_matter():
    keys, width = qwerty(1708, 400)  # the same keyboard drawn twice the size
    path = [(x * 2, y * 2) for x, y in traced("swipe")]
    assert GeometricDecoder().decode("en/words", LEXICON.counts(), resample(path, 64), keys, width, 3)[0] == "swipe"


def test_fast_enough():
    decoder = GeometricDecoder()
    started = time.perf_counter()
    decoder.prepare("en/words", LEXICON.counts(), frozenset(KEYS))
    prepare = time.perf_counter() - started
    rng = random.Random(3)
    words = ["hello", "keyboard", "information", "the", "something", "great", "between", "swiping", "polykey", "frame"]
    times = []
    for word in words * 3:
        path = resample(traced(word, rng, noise=0.2), 64)
        started = time.perf_counter()
        decoder.decode("en/words", LEXICON.counts(), path, KEYS, KEY_WIDTH, 5)
        times.append(time.perf_counter() - started)
    # Generous for slow CI machines; on a desktop, preparing takes about 0.1 s and a decode about 10 ms.
    assert prepare < 2.0
    assert sorted(times)[len(times) // 2] < 0.1, times


def handle(request: dict, lexicons=None) -> dict:
    return Swipe(lexicons or Lexicons([ROOT / "packs"])).handle(request)


def request(**changes) -> dict:
    keys = {k: list(v) for k, v in KEYS.items()}
    path = [list(p) for p in resample(traced("hello"), 64)]
    return {"lexicon": "en/words", "path": path, "keys": keys, "keyWidth": KEY_WIDTH, "limit": 5, **changes}


def test_the_request_is_checked():
    assert handle(request())["words"][0] == "hello"
    assert handle(request(lexicon="en/nope"))["error"] == "no-lexicon"
    assert handle(request(path=[[0, 0]]))["error"] == "bad-path"
    assert handle(request(path=[[0, 0], ["x", 1]]))["error"] == "bad-path"
    assert handle(request(path=[[0, 0]] * 600))["error"] == "bad-path"
    assert handle(request(path=[[0, 0], [float("nan"), 1]]))["error"] == "bad-path"
    assert handle(request(keys={"a": [1, 2]}))["error"] == "bad-keys"
    assert handle(request(keys={"ab": [1, 2], "c": [3, 4]}))["error"] == "bad-keys"
    assert handle(request(limit=0))["error"] == "bad-limit"
    assert handle(request(limit=True))["error"] == "bad-limit"
    assert handle(request(keyWidth=0))["error"] == "bad-key-width"
    assert handle(request(prepare=True, path=None)) == {"ok": True, "words": []}


def test_another_decoder_can_take_its_place():
    class Fixed:
        id = "fixed"

        def decode(self, lexicon_id, counts, path, keys, key_width, limit):
            return ["neural"][:limit]

    reply = Swipe(Lexicons([ROOT / "packs"]), Fixed()).handle(request())
    assert reply == {"ok": True, "words": ["neural"], "engine": "fixed"}


def test_the_bridge_answers_swipe_and_never_logs_the_path_or_words(capsys):
    lines: list[str] = []

    class Capture(Log):
        def info(self, message: str) -> None:
            lines.append(message)

    bridge = Bridge(Capture(), lexicons=Lexicons([ROOT / "packs"]))
    reply = asyncio.run(bridge.handle(json.dumps({"id": 4, "op": "swipe", **request()})))
    assert reply["id"] == 4 and reply["ok"] and reply["words"][0] == "hello"
    broken = asyncio.run(bridge.handle(json.dumps({"id": 5, "op": "swipe", **request(keys=None)})))
    assert broken == {"id": 5, "ok": False, "error": "bad-keys"}
    asyncio.run(bridge.handle(json.dumps({"id": 6, "op": "swipe", **request(prepare=True)})))
    assert any(line.startswith("swipe: en/words ready in ") for line in lines)  # a timing, nothing typed
    assert not any("hello" in line for line in lines)
    assert "hello" not in capsys.readouterr().out
