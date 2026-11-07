"""The speech helper process: loads transcribe.cpp (through its own ctypes binding, from the engine
directory polykey installed) and one model, then recognizes phrases sent on stdin until stdin closes.

Run as `python3 -I -B worker.py ENGINE_DIR MODEL THREADS`, apart from the sidecar, so a native crash
ends this process only and the model's memory goes when it exits. Standard library only: it imports
nothing from polykey.

Protocol over stdin and stdout: one JSON line from the helper once the model is loaded,
  {"ready": true, "cpu": "<the ggml CPU variant in use>"} or {"error": code},
then, per phrase, a JSON line {"language": "en", "bytes": n} and n bytes of 16 kHz mono s16le PCM from
the sidecar, answered with a JSON line {"text": ...} or {"error": code}.

Only replies reach the sidecar: native code that prints gets /dev/null on file descriptor 1 (replies
go to a copy of it), and stderr is /dev/null too. No audio or text is ever written anywhere else.

    python3 -I worker.py ENGINE_DIR MODEL THREADS --check FILE.wav
prints the text of a 16 kHz mono 16-bit WAV and how long it took (docs/DICTATION.md, "Check the engine").
"""

import array
import json
import os
import sys
import time

MAX_PHRASE_BYTES = 30 * 16000 * 2  # the sidecar sends at most 25 s
MAX_TEXT = 4096


def cpu_variant() -> str:
    """The ggml CPU library this process mapped (ggml picks the best one the CPU supports)."""
    try:
        with open("/proc/self/maps", encoding="utf-8") as maps:
            for line in maps:
                name = line.rsplit("/", 1)[-1].strip()
                if name.startswith("libggml-cpu") and name.endswith(".so"):
                    return name[len("libggml-cpu-") : -len(".so")] or "cpu"
    except OSError:
        pass
    return "unknown"


def load(engine: str, model_path: str, threads: int):
    os.environ["TRANSCRIBE_LIBRARY"] = os.path.join(engine, "lib", "libtranscribe.so")
    os.environ["TRANSCRIBE_BACKEND"] = "cpu"  # the engine directory has no GPU backend anyway
    sys.path.insert(0, os.path.join(engine, "python"))
    import transcribe_cpp  # loads the library and its ggml backends from lib/

    transcribe_cpp.set_log_callback(lambda level, message: None)
    model = transcribe_cpp.Model(model_path, backend="cpu")
    languages = set(model.capabilities.languages)
    return transcribe_cpp, model, model.session(n_threads=threads), languages


def floats(pcm: bytes) -> array.array:
    samples = array.array("h", pcm[: len(pcm) - len(pcm) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    return array.array("f", (s / 32768.0 for s in samples))


def recognize(session, languages, pcm: bytes, language: str) -> str:
    # A model that lists the language is told it; others (one language, or detecting it) choose.
    result = session.run(floats(pcm), language=language if language in languages else None)
    return result.text[:MAX_TEXT]


def check(engine: str, model_path: str, threads: int, wav_path: str) -> int:
    import wave

    with wave.open(wav_path, "rb") as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (16000, 1, 2):
            print("needs a 16 kHz mono 16-bit WAV", file=sys.stderr)
            return 2
        pcm = w.readframes(w.getnframes())
    started = time.monotonic()
    _tc, _model, session, languages = load(engine, model_path, threads)
    loaded = time.monotonic()
    text = recognize(session, languages, pcm, "en")
    print(f"cpu {cpu_variant()}, loaded in {loaded - started:.1f} s, recognized in {time.monotonic() - loaded:.1f} s")
    print(text)
    return 0


def serve(engine: str, model_path: str, threads: int) -> int:
    out = os.fdopen(os.dup(1), "wb", buffering=0)
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    reply = lambda message: out.write(json.dumps(message).encode("ascii") + b"\n")
    try:
        tc, _model, session, languages = load(engine, model_path, threads)
    except Exception as error:  # a missing or broken engine or model
        reply(
            {
                "error": "model-failed"
                if type(error).__name__ in ("ModelLoadError", "ModelFileNotFound")
                else "engine-failed"
            }
        )
        return 1
    reply({"ready": True, "cpu": cpu_variant()})
    stdin = sys.stdin.buffer
    while True:
        line = stdin.readline()
        if not line:
            return 0  # the sidecar closed the pipe
        try:
            request = json.loads(line)
            size = int(request["bytes"])
            language = str(request.get("language", ""))
        except (ValueError, KeyError, TypeError):
            reply({"error": "bad-request"})
            return 1
        if not 0 < size <= MAX_PHRASE_BYTES:
            reply({"error": "bad-request"})
            return 1
        pcm = stdin.read(size)
        if len(pcm) != size:
            return 0
        try:
            reply({"text": recognize(session, languages, pcm, language)})
        except tc.TranscribeError as error:
            reply({"error": "too-long" if isinstance(error, tc.InputTooLong) else "helper-failed"})
        del pcm


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 5 and args[3] == "--check":
        sys.exit(check(args[0], args[1], int(args[2]), args[4]))
    if len(args) != 3:
        sys.exit("usage: worker.py ENGINE_DIR MODEL THREADS [--check FILE.wav]")
    sys.exit(serve(args[0], args[1], int(args[2])))
