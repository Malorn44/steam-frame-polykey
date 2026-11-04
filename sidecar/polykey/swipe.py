"""Swipe typing: a path traced over the letter keys becomes ranked words.

The page sends the path and the letter keys' centres as it drew them (CSS px), so any layout pack can
swipe. Decoders sit behind `Decoder`, so a neural one could replace the geometric one later. Paths and
words are typed content: never logged.

`GeometricDecoder` is template matching in the manner of SHARK2 (Kristensson and Zhai, 2004). A word's
ideal path runs straight through its letters' key centres (doubled letters once). Candidates are pruned
by the keys near the swipe's start and end and by path length; each one left is scored by how far the
swipe is from that ideal path (location), how different its shape is once both are scaled to the same
size (shape), and how common the word is. Work that depends only on the word list or the geometry is
done once and cached, so a decode only touches the few hundred words that survive pruning.
"""
from __future__ import annotations

import heapq
import math
import unicodedata
from collections import OrderedDict
from itertools import accumulate
from typing import Mapping, Optional, Protocol, Sequence

Point = tuple[float, float]

# Points each path and template is resampled to, evenly spaced along its length; fewer for the first,
# coarse pass over every candidate, which keeps the best CANDIDATES for the full score.
SAMPLES = 32
COARSE_SAMPLES = 8
CANDIDATES = 40
# A swipe's first and last letters are keys within this many key widths of where it started and ended.
START_RADIUS = 1.0
END_RADIUS = 1.1
# How much longer than a word's ideal path a swipe may be (a ratio and key widths: a laser overshoots
# corners and trembles), and how much shorter (cutting corners).
LONGER = (1.6, 1.0)
SHORTER = (1.3, 0.75)
# Score = frequency - location² / (2 σ²) - shape² / (2 σ²). Word counts are 0-255 on a log scale,
# about 13 steps per natural-log unit of frequency (AOSP word lists).
LOCATION_SIGMA = 0.25  # key widths
SHAPE_SIGMA = 0.2  # of the shape's larger side
END_SIGMA = 0.35  # key widths, for where the swipe starts and ends
FREQUENCY_WEIGHT = 0.35
FREQUENCY_SCALE = 13.0
# Characters left out of a word's path (don't is swiped as dont).
SKIPPED = frozenset("'’-.")
# Geometries kept (a resized keyboard has new centres), templates kept per geometry (about 7 KB each),
# word-list indexes kept.
MAX_GEOMETRIES = 4
MAX_TEMPLATES = 4000
MAX_INDEXES = 2

MAX_POINTS = 512
MAX_KEYS = 64
MAX_LIMIT = 8


class Decoder(Protocol):
    """Path + key centres -> the likeliest words, best first."""

    id: str

    def decode(self, lexicon_id: str, counts: Mapping[str, int], path: Sequence[Point],
               keys: Mapping[str, Point], key_width: float, limit: int) -> list[str]: ...


def resample(points: Sequence[Point], n: int = SAMPLES) -> list[Point]:
    """n points evenly spaced along the polyline (all at the start for a single point)."""
    if not points:
        return []
    walked = list(accumulate(map(math.dist, points, points[1:]), initial=0.0))
    total = walked[-1]
    if total == 0:
        return [points[0]] * n
    out: list[Point] = []
    interval, segment, last = total / (n - 1), 0, len(points) - 2
    for j in range(n):
        goal = j * interval
        while segment < last and walked[segment + 1] < goal:
            segment += 1
        span = walked[segment + 1] - walked[segment]
        t = min(1.0, (goal - walked[segment]) / span) if span > 0 else 0.0
        (x0, y0), (x1, y1) = points[segment], points[segment + 1]
        out.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    return out


def path_length(points: Sequence[Point]) -> float:
    return sum(math.dist(a, b) for a, b in zip(points, points[1:]))


def normalized(points: Sequence[Point]) -> list[Point]:
    """The shape alone: centred on its centroid and scaled so its larger side is 1."""
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    size = max(max(xs) - min(xs), max(ys) - min(ys)) or 1.0
    return [((x - cx) / size, (y - cy) / size) for x, y in points]


def mean_distance(a: Sequence[Point], b: Sequence[Point]) -> float:
    return sum(map(math.dist, a, b)) / len(a)


def fold(word: str, letters: frozenset[str]) -> Optional[str]:
    """The keys a word is swiped through (lower case, accents on their base letter, doubles once), or None
    when one of its letters has no key."""
    keys: list[str] = []
    for ch in unicodedata.normalize("NFD", word.lower()):
        if ch in SKIPPED or unicodedata.combining(ch):
            continue
        if ch not in letters:
            return None
        if not keys or keys[-1] != ch:
            keys.append(ch)
    return "".join(keys)


class _Index:
    """A word list for one set of letter keys: words by (first key, last key), most frequent first, each
    with its key path and its frequency term."""

    def __init__(self, counts: Mapping[str, int], letters: frozenset[str]) -> None:
        best: dict[str, tuple[str, int, str]] = {}  # lower case -> its most frequent spelling (help, not Help)
        for word, count in counts.items():
            lower = word.lower()
            if lower in best and best[lower][1] >= count:
                continue
            keys = fold(word, letters)
            if keys is not None and len(keys) >= 2:  # one key is a tap, not a swipe
                best[lower] = (word, count, keys)
        self.buckets: dict[tuple[str, str], list[tuple[float, str, str]]] = {}
        for word, count, keys in best.values():
            self.buckets.setdefault((keys[0], keys[-1]), []).append((FREQUENCY_WEIGHT * count / FREQUENCY_SCALE, keys, word))
        for bucket in self.buckets.values():
            bucket.sort(reverse=True)


class _Geometry:
    """Key centres in key widths, with key paths' lengths and ideal templates made on first use. Templates
    are the bulk of the memory, so only the most recently used are kept."""

    def __init__(self, keys: Mapping[str, Point], key_width: float) -> None:
        self.centres = {k: (x / key_width, y / key_width) for k, (x, y) in keys.items()}
        self.lengths: dict[str, float] = {}
        self.templates: OrderedDict[str, tuple[list[Point], list[Point]]] = OrderedDict()

    def length(self, keys: str) -> float:
        known = self.lengths.get(keys)
        if known is None:
            known = self.lengths[keys] = path_length([self.centres[k] for k in keys])
        return known

    def template(self, keys: str) -> tuple[list[Point], list[Point]]:
        """(resampled path, its normalized shape) of a key path."""
        known = self.templates.get(keys)
        if known is None:
            points = resample([self.centres[k] for k in keys])
            known = self.templates[keys] = (points, normalized(points))
            if len(self.templates) > MAX_TEMPLATES:
                self.templates.popitem(last=False)
        else:
            self.templates.move_to_end(keys)
        return known


class GeometricDecoder:
    id = "geometric"

    def __init__(self) -> None:
        self._indexes: OrderedDict[tuple, _Index] = OrderedDict()
        self._geometries: OrderedDict[tuple, _Geometry] = OrderedDict()

    def _index(self, lexicon_id: str, counts: Mapping[str, int], letters: frozenset[str]) -> _Index:
        key = (lexicon_id, len(counts), letters)
        index = self._indexes.get(key)
        if index is None:
            index = self._indexes[key] = _Index(counts, letters)
            while len(self._indexes) > MAX_INDEXES:
                self._indexes.popitem(last=False)
        self._indexes.move_to_end(key)
        return index

    def _geometry(self, keys: Mapping[str, Point], key_width: float) -> _Geometry:
        # Rounded, so a layout redrawn at the same size reuses its templates.
        key = (round(key_width, 1),) + tuple(sorted((k, round(x, 1), round(y, 1)) for k, (x, y) in keys.items()))
        geometry = self._geometries.get(key)
        if geometry is None:
            geometry = self._geometries[key] = _Geometry(keys, key_width)
            while len(self._geometries) > MAX_GEOMETRIES:
                self._geometries.popitem(last=False)
        self._geometries.move_to_end(key)
        return geometry

    def prepare(self, lexicon_id: str, counts: Mapping[str, int], letters: frozenset[str]) -> None:
        """Build the word list's index ahead of the first swipe."""
        self._index(lexicon_id, counts, letters)

    def decode(self, lexicon_id: str, counts: Mapping[str, int], path: Sequence[Point],
               keys: Mapping[str, Point], key_width: float, limit: int) -> list[str]:
        if len(path) < 2 or len(keys) < 2 or key_width <= 0:
            return []
        index = self._index(lexicon_id, counts, frozenset(keys))
        geometry = self._geometry(keys, key_width)
        centres = geometry.centres
        raw = [(x / key_width, y / key_width) for x, y in path]
        swipe = resample(raw)
        shape = normalized(swipe)
        length = path_length(swipe)  # resampled: tremor adds less
        start, end = raw[0], raw[-1]
        near_start = {k: math.dist(start, c) for k, c in centres.items()}
        near_end = {k: math.dist(end, c) for k, c in centres.items()}
        firsts = [k for k, d in near_start.items() if d <= START_RADIUS] or [min(near_start, key=near_start.__getitem__)]
        lasts = [k for k, d in near_end.items() if d <= END_RADIUS] or [min(near_end, key=near_end.__getitem__)]
        location_scale = 1 / (2 * LOCATION_SIGMA ** 2)
        shape_scale = 1 / (2 * SHAPE_SIGMA ** 2)
        ends_scale = 1 / (2 * END_SIGMA ** 2)
        # Every word in a bucket starts and ends on the same keys, so the ends' cost is the bucket's.
        # Buckets go cheapest first and words most frequent first; a word can score no more than its
        # frequency less that cost, so the rest of a bucket is skipped once that cannot reach the best few.
        buckets = sorted(((near_start[f] ** 2 + near_end[l] ** 2) * ends_scale, (f, l)) for f in firsts for l in lasts)
        # First a coarse score from a few points for every word left, then the full one for the best few.
        coarse_swipe = resample(swipe, COARSE_SAMPLES)
        coarse_shape = normalized(coarse_swipe)
        rough: list[tuple[float, float, str, str]] = []  # a min-heap of the best (score, its prior, key path, word)
        for ends, pair in buckets:
            for frequency, keys_path, word in index.buckets.get(pair, ()):
                if len(rough) == CANDIDATES and frequency - ends <= rough[0][0]:
                    break
                ideal = geometry.length(keys_path)
                if length > ideal * LONGER[0] + LONGER[1] or length * SHORTER[0] + SHORTER[1] < ideal:
                    continue
                points = resample([centres[k] for k in keys_path], COARSE_SAMPLES)
                location = mean_distance(coarse_swipe, points)
                form = mean_distance(coarse_shape, normalized(points))
                prior = frequency - ends
                score = prior - location * location * location_scale - form * form * shape_scale
                if len(rough) < CANDIDATES:
                    heapq.heappush(rough, (score, prior, keys_path, word))
                elif score > rough[0][0]:
                    heapq.heapreplace(rough, (score, prior, keys_path, word))
        scored: list[tuple[float, str]] = []
        for _, prior, keys_path, word in rough:
            points, ideal_shape = geometry.template(keys_path)
            location = mean_distance(swipe, points)
            form = mean_distance(shape, ideal_shape)
            scored.append((prior - location * location * location_scale - form * form * shape_scale, word))
        return [word for _, word in heapq.nlargest(limit, scored)]


def _point(value: object) -> Optional[Point]:
    if isinstance(value, (list, tuple)) and len(value) == 2 \
            and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value):
        return float(value[0]), float(value[1])
    return None


class Swipe:
    """The `swipe` bridge op: checks the request, then asks the decoder with the keyboard's word list."""

    def __init__(self, lexicons, decoder: Optional[Decoder] = None) -> None:
        self._lexicons = lexicons
        self._decoder = decoder or GeometricDecoder()

    def handle(self, request: dict) -> dict:
        lexicon_id, raw_path, raw_keys = request.get("lexicon"), request.get("path"), request.get("keys")
        limit, key_width = request.get("limit", 5), request.get("keyWidth")
        lexicon = self._lexicons.get(lexicon_id) if self._lexicons and isinstance(lexicon_id, str) else None
        if lexicon is None:
            return {"ok": False, "error": "no-lexicon"}
        if not isinstance(raw_keys, dict) or not 2 <= len(raw_keys) <= MAX_KEYS:
            return {"ok": False, "error": "bad-keys"}
        keys = {k: _point(v) for k, v in raw_keys.items() if isinstance(k, str) and len(k) == 1}
        if len(keys) != len(raw_keys) or any(v is None for v in keys.values()):
            return {"ok": False, "error": "bad-keys"}
        if request.get("prepare") is True:
            prepare = getattr(self._decoder, "prepare", None)
            if prepare:
                prepare(lexicon_id, lexicon.counts(), frozenset(keys))
            return {"ok": True, "words": []}
        if not isinstance(raw_path, list) or not 2 <= len(raw_path) <= MAX_POINTS:
            return {"ok": False, "error": "bad-path"}
        path = [_point(p) for p in raw_path]
        if any(p is None for p in path):
            return {"ok": False, "error": "bad-path"}
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_LIMIT:
            return {"ok": False, "error": "bad-limit"}
        if not isinstance(key_width, (int, float)) or isinstance(key_width, bool) or not 1 <= key_width <= 1000:
            return {"ok": False, "error": "bad-key-width"}
        words = self._decoder.decode(lexicon_id, lexicon.counts(), path, keys, float(key_width), limit)  # type: ignore[arg-type]
        return {"ok": True, "words": words, "engine": self._decoder.id}
