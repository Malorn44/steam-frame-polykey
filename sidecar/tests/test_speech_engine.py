"""The helper process: engine.py driving the real worker.py, over a stand-in transcribe_cpp."""
from __future__ import annotations

import asyncio
import io
from pathlib import Path

import pytest

from fake_speech import fake_engine, tone, tool
from polykey.injector import Log
from polykey.speech import SpeechError, engine as engine_module
from polykey.speech.engine import Engine, clean, scope


def test_clean():
    assert clean(" Hello  world. [BLANK_AUDIO] ") == "Hello world."
    assert clean("♪♪") == "" and clean("(music)") == "" and clean("（拍手）") == ""
    assert clean("今日は (たぶん) 晴れ") == "今日は (たぶん) 晴れ"
    assert clean(None) == ""


def test_the_scope_caps_memory_for_the_model():
    assert "MemoryMax=1500M" in scope(1000) and "MemoryMax=512M" in scope(100) and "CPUWeight=50" in scope(1000)


@pytest.fixture
def helper(tmp_path, monkeypatch):
    log = tmp_path / "log"
    log.write_text("")
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.setenv("FAKE_TEXT", " Hello there. ")
    home = tmp_path / "speech"
    fake_engine(home)
    models = home / "models"
    models.mkdir()
    for name in ("a.gguf", "b.gguf"):
        (models / name).write_bytes(b"model")
    return home, models, log


def make(home, out=None, **kwargs):
    kwargs.setdefault("use_scope", False)
    return Engine(home, "0.4.1", Log(out or io.StringIO()), **kwargs)


def test_transcribes_through_the_helper_and_unloads_when_idle(helper):
    home, models, log = helper
    out = io.StringIO()

    async def main():
        engine = make(home, out, idle=0.5)
        try:
            assert await engine.transcribe(tone(1.0), "en", models / "a.gguf", 300) == "Hello there."
            assert await engine.transcribe(tone(0.5), "ko", models / "a.gguf", 300) == "Hello there."
            assert engine.loaded
            await asyncio.sleep(1.0)
            assert not engine.loaded
            assert await engine.transcribe(tone(0.5), "ja", models / "a.gguf", 300) == "Hello there."  # loads again
        finally:
            await engine.close()
        assert not engine.loaded
    asyncio.run(main())
    lines = log.read_text().splitlines()
    assert lines.count("load a.gguf backend=cpu env=cpu library=libtranscribe.so") == 2
    assert lines.count("session threads=4") == 2 and "log callback" in lines
    # PCM goes in as float samples; a language the model lists is passed on, another is left to it.
    assert [line for line in lines if line.startswith("run")] == [
        "run samples=16000 type=f language=en", "run samples=8000 type=f language=None", "run samples=8000 type=f language=ja"]
    assert "Hello" not in out.getvalue()  # never the transcript in the log
    assert "speech helper loaded (a, cpu unknown" in out.getvalue() and "unloaded (idle)" in out.getvalue()


def test_another_model_restarts_the_helper(helper):
    home, models, log = helper
    out = io.StringIO()

    async def main():
        engine = make(home, out)
        try:
            await engine.transcribe(tone(0.5), "en", models / "a.gguf", 300)
            await engine.transcribe(tone(0.5), "en", models / "b.gguf", 300)
            await engine.unload_model(models / "a.gguf")  # not loaded: nothing happens
            assert engine.loaded
            await engine.unload_model(models / "b.gguf")
            assert not engine.loaded
        finally:
            await engine.close()
    asyncio.run(main())
    assert [line.split()[1] for line in log.read_text().splitlines() if line.startswith("load")] == ["a.gguf", "b.gguf"]
    assert "unloaded (another model)" in out.getvalue()


async def code(engine, model, language="en", seconds=0.5):
    try:
        return await engine.transcribe(tone(seconds), language, model, 300)
    except SpeechError as error:
        return error.code
    finally:
        await engine.close()


def test_missing_engine_or_model_a_failing_load_and_a_crash(helper, tmp_path, monkeypatch):
    home, models, _ = helper
    assert asyncio.run(code(make(tmp_path / "none"), models / "a.gguf")) == "no-engine"
    assert asyncio.run(code(make(home), models / "none.gguf")) == "no-model"
    assert asyncio.run(code(make(home), models / "a.gguf", "x;rm")) == "bad-language"
    monkeypatch.setenv("FAKE_LOAD_FAIL", "1")
    assert asyncio.run(code(make(home), models / "a.gguf")) == "model-failed"
    monkeypatch.delenv("FAKE_LOAD_FAIL")
    monkeypatch.setenv("FAKE_CRASH", "1")
    assert asyncio.run(code(make(home), models / "a.gguf")) == "helper-failed"


def test_a_broken_engine_reports_it(helper, monkeypatch):
    home, models, _ = helper
    (home / "engine" / "0.4.1" / "python" / "transcribe_cpp" / "__init__.py").write_text("raise ImportError('no library')\n")
    assert asyncio.run(code(make(home), models / "a.gguf")) == "engine-failed"


def test_falls_back_when_the_scope_launcher_fails(helper, tmp_path, monkeypatch):
    home, models, _ = helper
    false = tool(tmp_path, "systemd-run", "import sys; sys.exit(1)\n")
    monkeypatch.setenv("PATH", f"{tmp_path}:/usr/bin:/bin")
    out = io.StringIO()
    assert asyncio.run(code(make(home, out, use_scope=True), models / "a.gguf")) == "Hello there."
    assert "no systemd scope" in out.getvalue() and false.exists()


def test_the_time_limit_grows_with_the_phrase(helper, monkeypatch):
    home, models, _ = helper
    monkeypatch.setenv("FAKE_INFER_SECONDS", "0.6")
    limited = lambda: make(home, request_timeout=0.3, request_per_second=0.25)
    assert asyncio.run(code(limited(), models / "a.gguf", seconds=0.5)) == "helper-timeout"  # 0.3 + 0.125 s: too short
    assert asyncio.run(code(limited(), models / "a.gguf", seconds=2.0)) == "Hello there."  # 0.3 + 0.5 s: enough


def test_worker_module_is_standalone():
    # It runs with -I as a script: it must not import polykey (or anything outside the standard library).
    source = Path(engine_module.WORKER).read_text(encoding="utf-8")
    assert "polykey" not in source.split('"""', 2)[2] and "from ." not in source
