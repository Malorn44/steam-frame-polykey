"""Fakes for dictation tests: synthetic PCM, small executables standing in for pw-record, pw-dump and
pw-link (Python scripts run with this interpreter), and a stand-in for transcribe.cpp's binding."""

from __future__ import annotations

import math
import struct
import sys
from pathlib import Path

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
