"""Fakes for dictation tests: synthetic PCM, small executables standing in for pw-record, pw-dump and
pw-link (Python scripts run with this interpreter), and a stand-in for transcribe.cpp's binding."""

from __future__ import annotations

import math
import random
import struct
import sys
from pathlib import Path
from typing import Optional

RATE = 16000


def tone(seconds: float, amplitude: int = 4000, hz: float = 220.0) -> bytes:
    n = int(RATE * seconds)
    return struct.pack(f"<{n}h", *(int(amplitude * math.sin(2 * math.pi * hz * i / RATE)) for i in range(n)))


def noise(seconds: float, amplitude: int = 12) -> bytes:
    """Quiet room noise (about -70 dB), deterministic."""
    n = int(RATE * seconds)
    return struct.pack(f"<{n}h", *(amplitude if (i * 7919) % 3 else -amplitude for i in range(n)))


def zeros(seconds: float) -> bytes:
    return bytes(2 * int(RATE * seconds))


# --- sounds that are loud but not speech, and a voice -------------------------------------------------
# Synthetic and deterministic: the gate is tested without recordings. Built as float samples, then packed.


def pack(samples: list) -> bytes:
    return struct.pack(f"<{len(samples)}h", *(max(-32768, min(32767, int(s))) for s in samples))


def room(seconds: float, seed: int = 1) -> list:
    """Quiet room noise like noise() (about -70 dB), as floats to mix sounds into."""
    r = random.Random(seed)
    return [r.gauss(0, 12) for _ in range(int(RATE * seconds))]


def mix(base: list, sound: list, at: int) -> list:
    for i, s in enumerate(sound[: max(0, len(base) - at)]):
        base[at + i] += s
    return base


def ring(hz: float, decay: float, amplitude: float, seconds: float) -> list:
    """A resonance struck once: a sine that dies away with time constant `decay` (seconds)."""
    return [
        amplitude * math.exp(-i / (decay * RATE)) * math.sin(2 * math.pi * hz * i / RATE)
        for i in range(int(RATE * seconds))
    ]


def burst(seconds: float, amplitude: float, seed: int, decay: Optional[float] = None) -> list:
    r = random.Random(seed)
    tau = (decay or seconds) * RATE
    return [amplitude * math.exp(-i / tau) * r.gauss(0, 1) for i in range(int(RATE * seconds))]


def click(amplitude: float, seed: int) -> list:
    """A key's click: a sharp edge, a high ring and a dull thump under it, all gone within 30 ms."""
    r = random.Random(seed)
    out = burst(0.008, amplitude, seed, 0.001) + [0.0] * int(RATE * 0.05)
    mix(out, ring(r.uniform(1500, 4500), 0.002, amplitude * 0.8, 0.04), 0)
    return mix(out, ring(r.uniform(150, 400), r.uniform(0.003, 0.01), amplitude * 0.5, 0.05), 0)


BUZZ = 0.25  # a haptic tick 12 dB under the key's click: the controller is in the hand, far from the mic


def typing(
    seconds: float, per_second: float = 6.0, amplitude: float = 6000, buzz: bool = False, seed: int = 5
) -> bytes:
    """Keys pressed about `per_second` times a second over room noise: each a press (two clicks a few
    ms apart) and a release 70–140 ms later; with `buzz`, a controller's haptic tick (30 ms at 170 Hz)
    on each press."""
    r = random.Random(seed)
    out = room(seconds, seed)
    t = 0.0
    while t < seconds - 0.25:
        a, at = amplitude * r.uniform(0.4, 1.2), int(t * RATE)
        mix(out, click(a * 0.5, r.randrange(1 << 30)), at)
        mix(out, click(a, r.randrange(1 << 30)), at + int(RATE * r.uniform(0.004, 0.012)))
        mix(out, click(a * 0.6, r.randrange(1 << 30)), at + int(RATE * r.uniform(0.07, 0.14)))
        if buzz:
            mix(out, [a * BUZZ * math.sin(2 * math.pi * 170 * i / RATE) for i in range(int(RATE * 0.03))], at)
        t += r.expovariate(per_second) + 0.04
    return pack(out)


def knocks(seconds: float, decay: float = 0.03, seed: int = 6) -> bytes:
    """Knocks on a desk or the headset every 0.2–0.6 s: a low ring (90–250 Hz) that dies away."""
    r = random.Random(seed)
    out = room(seconds, seed)
    t = 0.0
    while t < seconds - 0.2:
        mix(out, ring(r.uniform(90, 250), decay, r.uniform(4000, 10000), 0.2), int(t * RATE))
        t += r.uniform(0.2, 0.6)
    return pack(out)


def clicks(seconds: float, seed: int = 9) -> bytes:
    """A controller's trigger and buttons clicked every 0.15–0.6 s."""
    r = random.Random(seed)
    out = room(seconds, seed)
    t = 0.0
    while t < seconds - 0.2:
        mix(out, click(r.uniform(3000, 9000), r.randrange(1 << 30)), int(t * RATE))
        t += r.uniform(0.15, 0.6)
    return pack(out)


def hiss(seconds: float, seed: int = 7) -> bytes:
    """Breaths, rustles and bumps: bursts of noise, 30–120 ms each."""
    r = random.Random(seed)
    out = room(seconds, seed)
    t = 0.0
    while t < seconds - 0.2:
        mix(out, burst(r.uniform(0.03, 0.12), r.uniform(1000, 4000), r.randrange(1 << 30)), int(t * RATE))
        t += r.uniform(0.15, 0.6)
    return pack(out)


def voice(seconds: float, f0: float = 120.0, db: float = -24.0, seed: int = 8) -> bytes:
    """A voiced vowel at `db` dBFS (RMS; speech at the Frame's mic is about -24): a glottal pulse train
    (pitch falling 15% and jittered 1%) through formants at 730, 1090 and 2440 Hz (an "ah"), with a
    25 ms rise and fall."""
    r = random.Random(seed)
    n = int(RATE * seconds)
    source = [0.0] * n
    t = 0.0
    while t < n:
        period = RATE / (f0 * (1.075 - 0.15 * t / n))
        opening = int(period * 0.4)
        for k in range(min(opening, n - int(t))):
            source[int(t) + k] += math.sin(math.pi * k / opening) ** 2
        t += period * (1 + r.gauss(0, 0.01))
    out = source
    for hz, bandwidth in ((730, 90), (1090, 110), (2440, 170)):
        radius = math.exp(-math.pi * bandwidth / RATE)
        a1, a2, y1, y2, shaped = 2 * radius * math.cos(2 * math.pi * hz / RATE), -radius * radius, 0.0, 0.0, []
        for s in out:
            y1, y2 = (1 - radius) * s + a1 * y1 + a2 * y2, y1
            shaped.append(y1)
        out = shaped
    mean = sum(out) / n
    out = [s - mean for s in out]
    scale = 32768 * 10 ** (db / 20) / max(1e-9, math.sqrt(sum(s * s for s in out) / n))
    edge = int(RATE * 0.025)
    return pack([scale * min(1.0, i / edge, (n - i) / edge) * s for i, s in enumerate(out)])


def tool(directory: Path, name: str, body: str) -> Path:
    """An executable `name` in `directory` running `body` as Python."""
    path = directory / name
    path.write_text(f"#!{sys.executable}\n{body}", encoding="utf-8")
    path.chmod(0o755)
    return path


# pw-record: logs its arguments, writes $FAKE_PCM to stdout, then holds it open ($FAKE_HOLD) or ends.
PW_RECORD = r"""
import os, sys, time
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write("record " + " ".join(sys.argv[1:]) + " remote=" + os.environ.get("PIPEWIRE_REMOTE", "") + "\n")
if os.environ.get("FAKE_RECORD_SILENT") and "-P" in sys.argv:
    time.sleep(30)  # a linked recorder that never gets audio
data = open(os.environ["FAKE_PCM"], "rb").read()
step = 640 * int(os.environ.get("FAKE_FRAMES_PER_WRITE", "50"))
for i in range(0, len(data), step):
    sys.stdout.buffer.write(data[i:i + step])
    sys.stdout.buffer.flush()
    if os.environ.get("FAKE_REALTIME"):
        time.sleep(step / 32000)
if os.environ.get("FAKE_HOLD"):
    time.sleep(30)
"""

PW_DUMP = r"""
import os, sys
sys.stdout.write(open(os.environ["FAKE_DUMP"]).read())
"""

PW_LINK = r"""
import os, sys
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write("link " + " ".join(sys.argv[1:]) + "\n")
"""

# transcribe_cpp: the part of the binding worker.py uses. It logs what it was asked (never audio) and
# answers $FAKE_TEXT, or the next of $FAKE_TEXTS; $FAKE_LANGUAGES are the model's languages.
TRANSCRIBE_CPP = r"""
import os, sys, time
log = lambda line: open(os.environ["FAKE_LOG"], "a").write(line + "\n")
class TranscribeError(RuntimeError): pass
class InputTooLong(TranscribeError): pass
class ModelLoadError(TranscribeError): pass
def set_log_callback(handler): log("log callback")
class Caps: languages = tuple(filter(None, os.environ.get("FAKE_LANGUAGES", "en,ja").split(",")))
class Result:
    def __init__(self, text): self.text = text
class Session:
    def run(self, pcm, language=None):
        log("run samples=%d type=%s language=%s" % (len(pcm), pcm.typecode, language))
        time.sleep(float(os.environ.get("FAKE_INFER_SECONDS", "0")))
        if os.environ.get("FAKE_CRASH"):
            os._exit(9)
        print("native noise on stdout")
        texts = os.environ.get("FAKE_TEXTS")  # one per phrase, in order ("|" between; empty: no words)
        if texts is not None:
            Session.calls = getattr(Session, "calls", 0) + 1
            return Result((texts.split("|") + [""] * 99)[Session.calls - 1])
        return Result(os.environ.get("FAKE_TEXT", ""))
class Model:
    def __init__(self, path, backend="auto"):
        log("load %s backend=%s env=%s library=%s" % (os.path.basename(path), backend, os.environ.get("TRANSCRIBE_BACKEND"),
            os.path.basename(os.environ.get("TRANSCRIBE_LIBRARY", ""))))
        if os.environ.get("FAKE_LOAD_FAIL"):
            raise ModelLoadError("no")
        time.sleep(float(os.environ.get("FAKE_LOAD_SECONDS", "0")))
        self.capabilities = Caps()
    def session(self, n_threads=0):
        log("session threads=%d" % n_threads)
        return Session()
"""


def fake_engine(home: Path, version: str = "0.4.1") -> Path:
    """An installed engine whose binding is the fake above (the library file is never loaded)."""
    directory = home / "engine" / version
    (directory / "lib").mkdir(parents=True)
    (directory / "lib" / "libtranscribe.so").write_bytes(b"")
    (directory / "python" / "transcribe_cpp").mkdir(parents=True)
    (directory / "python" / "transcribe_cpp" / "__init__.py").write_text(TRANSCRIBE_CPP, encoding="utf-8")
    return directory
