from __future__ import annotations

import asyncio
import io
import itertools
import json
import math
import random
import time
from pathlib import Path

from polykey import packs, swipe
from polykey.bridge import Bridge
from polykey.injector import Log
from polykey.lexicon import UNUSED_S, Lexicon, Lexicons
from polykey.spellers import LOWERCASE, Spellers
from polykey.spellers.hangul import HangulSpeller
from polykey.swipe import GeometricDecoder, Swipe, fold, resample

ROOT = Path(__file__).resolve().parents[2]
CATALOG = packs.load(ROOT / "packs", ROOT / "packs/pack.schema.json", user=Path("/nonexistent"))["catalog"]


def drawn(layout_id: str = "en/qwerty", width: float = 854, height: float = 200):
    """The letter keys' centres of a bundled layout drawn width × height px, as the page sends them, a key's
    width, and the letters typed with Shift on each key (ㅃ on ㅂ), as the page sends them too."""
    rows = CATALOG["layouts"][layout_id]["rows"]
    row_height = height / len(rows)
    centres: dict[str, tuple[float, float]] = {}
    shifts: dict[str, str] = {}
    key_width = 0.0
    for r, row in enumerate(rows):
        keys = [k if isinstance(k, dict) else {"type": "char", "char": k} for k in row]
        units = sum(k.get("w", 1) for k in keys)
        x = 0.0
        for key in keys:
            w = key.get("w", 1) * width / units
            if key["type"] == "char" and key["char"].isalpha():
                centres[key["char"]] = (x + w / 2, r * row_height + row_height / 2)
                key_width = w
                if key.get("shift", key["char"]) != key["char"]:
                    shifts[key["shift"]] = key["char"]
            x += w
    return centres, key_width, shifts


KEYS, KEY_WIDTH, _ = drawn()
LEXICON = Lexicons([ROOT / "packs"]).get("en/words")
KO_KEYS, KO_WIDTH, KO_SHIFTS = drawn("ko/dubeolsik")
HANGUL = HangulSpeller(CATALOG["tables"]["ko/hangul"]["hangul"])
KO_LEXICON = Lexicons([ROOT / "packs"]).get("ko/words")
ENGLISH = (KEYS, KEY_WIDTH, LOWERCASE, {})
KOREAN = (KO_KEYS, KO_WIDTH, HANGUL, KO_SHIFTS)


def traced(word: str, rng: random.Random | None = None, noise: float = 0.0, board=ENGLISH) -> list[tuple[float, float]]:
    """A swipe through the word's keys on a board (its centres, key width, speller and shifts): straight
    between them, each key landed on with some error, and sampled every few px as the laser reports it."""
    centres, width, speller, shifts = board
    keys = fold(word, frozenset(centres), speller, shifts)
    corners = [
        (
            centres[k][0] + (rng.gauss(0, noise) * width if rng else 0),
            centres[k][1] + (rng.gauss(0, noise * 0.7) * width if rng else 0),
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
    assert [fold(word, letters) for word in ("it’s", "e-mail", "St.")] == ["its", "email", "st"]
    assert fold("café", letters) == "cafe"  # an accent on its base letter
    assert fold("Paris", letters) == "paris"
    assert fold("naïve", frozenset("naive")) == "naive"
    assert fold("ñu", frozenset("u")) is None  # no key for n


def test_hangul_folds_onto_the_2set_keys_as_its_suggestions_spell_it():
    hangul = lambda word: fold(word, frozenset(KO_KEYS), HANGUL, KO_SHIFTS)
    assert hangul("한국") == "ㅎㅏㄴㄱㅜㄱ"
    assert hangul("과일") == "ㄱㅗㅏㅇㅣㄹ"  # a compound vowel: its two keys
    assert hangul("닭") == "ㄷㅏㄹㄱ"  # a compound final too
    assert hangul("빨리") == "ㅂㅏㄹㅣ"  # ㅃ on its key, ㅂ; the two ㄹ once
    assert hangul("했다") == "ㅎㅐㅅㄷㅏ" and hangul("얘기") == "ㅇㅐㄱㅣ"  # ㅆ on ㅅ, ㅒ on ㅐ
    assert hangul("까까") == "ㄱㅏㄱㅏ" and hangul("안녕") == "ㅇㅏㄴㅕㅇ"
    assert hangul("hello") is None and hangul("K팝") is None  # not Hangul: not on these keys
    assert fold("한국", frozenset(KO_KEYS)) is None  # spelled in lower case, Hangul is on no key


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


KOREAN_WORDS = (
    "한국 사람 우리 그리고 하지만 감사합니다 안녕하세요 학교 생각 시간 정말 오늘 빨리 과일 대한민국 사랑 친구 때문에"
    " 있습니다 했다 그런데 여러분 이야기 세계 경제 정부 가족 회사 음식 다음"
).split()


def ko_decode(path, limit=5, decoder=None):
    return (decoder or DECODER).decode(
        "ko/words", KO_LEXICON.counts(), resample(path, 64), KO_KEYS, KO_WIDTH, limit, HANGUL, KO_SHIFTS
    )


def test_a_korean_word_traced_through_its_2set_keys_ranks_first():
    found = {word: ko_decode(traced(word, board=KOREAN)) for word in KOREAN_WORDS}
    assert all(word in words for word, words in found.items()), found
    assert [word for word, words in found.items() if words[0] != word] == []


def test_most_sloppy_korean_swipes_still_rank_first_or_close():
    rng = random.Random(7)
    pool = [w for w in list(KO_LEXICON.counts())[50:3000] if len(fold(w, frozenset(KO_KEYS), HANGUL, KO_SHIFTS)) >= 3]
    top1 = top5 = 0
    for word in rng.sample(pool, 100):
        found = ko_decode(traced(word, rng, noise=0.2, board=KOREAN))
        top1 += found[:1] == [word]
        top5 += word in found
    # A little below English's bar (above): Korean words are longer, and share more of their paths.
    assert top1 >= 70 and top5 >= 85, (top1, top5)


def test_a_long_list_is_indexed_by_its_most_frequent_words(monkeypatch):
    monkeypatch.setattr(swipe, "MAX_WORDS", 2)
    lexicon = Lexicon.parse("rare\t1\nhello\t200\nhelp\t100\n")  # not in order of frequency
    decoder = GeometricDecoder()
    assert decoder.decode("t/w", lexicon.counts(), resample(traced("hello"), 64), KEYS, KEY_WIDTH, 5) == [
        "hello",
        "help",
    ]
    assert decoder.decode("t/w", lexicon.counts(), resample(traced("rare"), 64), KEYS, KEY_WIDTH, 5) == []


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
    keys, width, _ = drawn("en/qwerty", 1708, 400)  # the same keyboard drawn twice the size
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
    assert handle(request(shifts=["Q"]))["error"] == "bad-keys"
    assert handle(request(shifts={"Q": "?"}))["error"] == "bad-keys"  # onto no key
    assert handle(request(shifts={"QQ": "q"}))["error"] == "bad-keys"
    assert handle(request(shifts={"Q": "q"}))["words"][0] == "hello"
    assert handle(request(prepare=True, path=None)) == {"ok": True, "words": []}


def test_another_decoder_can_take_its_place():
    class Fixed:
        id = "fixed"

        def decode(self, lexicon_id, counts, path, keys, key_width, limit, speller, shifts):
            return ["neural"][:limit]

    reply = Swipe(Lexicons([ROOT / "packs"]), Fixed()).handle(request())
    assert reply == {"ok": True, "words": ["neural"], "engine": "fixed"}


def test_the_bridge_answers_swipe_and_never_logs_the_path_or_words(capsys):
    lines: list[str] = []

    class Capture(Log):
        def info(self, message: str) -> None:
            lines.append(message)

    bridge = Bridge(Capture(), lexicons=Lexicons([ROOT / "packs"]))
    asyncio.run(bridge.handle(json.dumps({"id": 3, "op": "swipe", **request(prepare=True)})))
    assert [line for line in lines if line.startswith("swipe: en/words ready in ")]  # a timing, nothing typed
    reply = asyncio.run(bridge.handle(json.dumps({"id": 4, "op": "swipe", **request()})))
    assert reply["id"] == 4 and reply["ok"] and reply["words"][0] == "hello"
    broken = asyncio.run(bridge.handle(json.dumps({"id": 5, "op": "swipe", **request(keys=None)})))
    assert broken == {"id": 5, "ok": False, "error": "bad-keys"}
    assert not any("hello" in line for line in lines)
    assert "hello" not in capsys.readouterr().out


def test_a_list_unloaded_takes_the_swipe_index_built_from_it_along():
    now = [0.0]
    lexicons = Lexicons([ROOT / "packs"], clock=lambda: now[0])
    decoder = GeometricDecoder()
    bridge = Bridge(Log(io.StringIO()), lexicons=lexicons, swipe=Swipe(lexicons, decoder))
    swipe = lambda **f: asyncio.run(bridge.handle(json.dumps({"id": 1, "op": "swipe", **request(**f)})))
    assert swipe(prepare=True)["ok"]
    decoder.prepare("mine/words", {"ab": 1}, frozenset("ab"))  # a list Lexicons never loaded
    now[0] = UNUSED_S
    bridge.unload_unused()
    assert [key[0] for key in decoder._indexes] == ["mine/words"]
    assert swipe()["words"][0] == "hello"  # loaded and indexed again


def korean_bridge(lines: list[str], now: list[float]) -> tuple[Bridge, GeometricDecoder]:
    """A bridge with the bundled packs, a clock to move on, and the spellers of the bundled keyboards."""

    class Capture(Log):
        def info(self, message: str) -> None:
            lines.append(message)

    log = Capture()
    lexicons = Lexicons([ROOT / "packs"], clock=lambda: now[0])
    decoder = GeometricDecoder()
    spellers = Spellers(lambda: CATALOG)
    return Bridge(log, lexicons=lexicons, swipe=Swipe(lexicons, decoder, log), spellers=spellers), decoder


def ko_request(**changes) -> dict:
    keys = {k: list(v) for k, v in KO_KEYS.items()}
    path = [list(p) for p in resample(traced("빨리", board=KOREAN), 64)]
    return {
        "op": "swipe",
        "lexicon": "ko/words",
        "path": path,
        "keys": keys,
        "keyWidth": KO_WIDTH,
        "limit": 5,
        **changes,
    }


def test_a_swipe_on_the_korean_keyboard_is_spelled_by_its_speller_and_never_logged(capsys):
    lines: list[str] = []
    bridge, _ = korean_bridge(lines, [0.0])
    ask = lambda **f: asyncio.run(bridge.handle(json.dumps({"id": 1, **ko_request(**f)})))
    assert ask(keyboard="ko/korean", shifts=KO_SHIFTS)["words"][0] == "빨리"
    assert ask(keyboard="ko/korean")["words"][0] != "빨리"  # without the shifts no word has ㅃ on a key
    assert ask()["words"] == []  # in lower case, no Hangul word is on these keys
    assert not any("빨리" in line or "ㅂ" in line for line in lines)
    assert "빨리" not in capsys.readouterr().out


def test_the_korean_list_is_prepared_once_and_unloaded_with_its_index_when_unused():
    lines: list[str] = []
    now = [0.0]
    bridge, decoder = korean_bridge(lines, now)
    ask = lambda **f: asyncio.run(
        bridge.handle(json.dumps({"id": 1, **ko_request(keyboard="ko/korean", shifts=KO_SHIFTS, **f)}))
    )
    assert ask(prepare=True, path=None) == {"id": 1, "ok": True, "words": []}
    assert ask(prepare=True, path=None)["ok"]  # drawn again: already built
    assert [line.split(" ready")[0] for line in lines] == ["swipe: ko/words"]  # one timing, nothing typed
    (index,) = decoder._indexes.values()
    assert len(index.buckets) > 100 and sum(map(len, index.buckets.values())) == swipe.MAX_WORDS
    now[0] = UNUSED_S
    bridge.unload_unused()
    assert decoder._indexes == {} and lines[-1] == "suggest: ko/words unloaded after 10 min unused"
    assert ask()["words"][0] == "빨리"  # loaded and indexed again
