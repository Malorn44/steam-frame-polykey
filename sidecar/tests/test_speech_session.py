from __future__ import annotations

import asyncio
import hashlib
import io
import json
import shutil
import tarfile
import zipfile

import pytest
from aiohttp import web

from fake_speech import PW_RECORD, TRANSCRIBE_CPP, fake_engine, noise, tone, tool, zeros
from polykey.bridge import Bridge
from polykey.injector import Log
from polykey.speech import session as session_module
from polykey.speech.capture import Tools
from polykey.speech.catalog import Catalog, Engine as EngineInfo, Model
from polykey.speech.download import Remote
from polykey.speech.engine import Engine
from polykey.speech.session import Dictation, bar_level, pick

TEXT = "今日は晴れです"
MODEL_BLOB = b"m" * 300_000


def model(model_id: str, languages: tuple, port: int = 9, blob: bytes = MODEL_BLOB) -> Model:
    remote = Remote(
        f"http://127.0.0.1:{port}/m/{model_id}.gguf", len(blob), hashlib.sha256(blob).hexdigest(), ("127.0.0.1",)
    )
    return Model(
        model_id,
        model_id,
        languages,
        remote,
        f"{model_id}.gguf",
        "MIT",
        f"{model_id} by someone",
        300,
        {"id": model_id, "languages": list(languages), "size": len(blob)},
    )


def engine_archives() -> tuple[bytes, bytes]:
    """A release with the stand-in binding: installing it gives an engine that really runs (in tests)."""
    native, wheel = io.BytesIO(), io.BytesIO()
    with tarfile.open(fileobj=native, mode="w:gz") as tar:
        for name, data in (
            ("libtranscribe.so", b""),
            ("libggml.so", b""),
            ("libggml-base.so", b""),
            ("libggml-cpu-x.so", b""),
            ("contract.json", b'{"version": "0.4.1"}'),
        ):
            info = tarfile.TarInfo("top/" + name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    with zipfile.ZipFile(wheel, "w") as whl:
        whl.writestr("transcribe_cpp/__init__.py", TRANSCRIBE_CPP)
    return native.getvalue(), wheel.getvalue()


NATIVE, WHEEL = engine_archives()


def catalog_at(port: int) -> Catalog:
    file = lambda name, blob: Remote(
        f"http://127.0.0.1:{port}/e/{name}", len(blob), hashlib.sha256(blob).hexdigest(), ("127.0.0.1",)
    )
    engine = EngineInfo("0.4.1", {"test": file("native.tgz", NATIVE)}, file("binding.whl", WHEEL), "engine by someone")
    return Catalog(
        engine,
        (model("en-model", ("en",), port), model("ja-model", ("ja", "zh"), port), model("any-model", ("*",), port)),
    )


async def server(slow: bool = False):
    """A local stand-in for GitHub and Hugging Face; `slow` sends model files in pieces over a few seconds."""

    async def serve_model(request):
        if not slow:
            return web.Response(body=MODEL_BLOB)
        response = web.StreamResponse(headers={"Content-Length": str(len(MODEL_BLOB))})
        await response.prepare(request)
        for i in range(0, len(MODEL_BLOB), 10_000):
            await response.write(MODEL_BLOB[i : i + 10_000])
            await asyncio.sleep(0.1)
        return response

    async def serve_engine(request):
        return web.Response(body=NATIVE if request.match_info["name"] == "native.tgz" else WHEEL)

    app = web.Application()
    app.add_routes([web.get("/m/{name}", serve_model), web.get("/e/{name}", serve_engine)])
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, site._server.sockets[0].getsockname()[1]


OPTIONS = {"schemes": ("http",), "machine": "test"}


@pytest.fixture
def setup(tmp_path, monkeypatch):
    """A Dictation with fake pw-record and engine, dictation on, the engine and two models in place."""
    log = tmp_path / "log"
    log.write_text("")
    pcm = tmp_path / "pcm"
    pcm.write_bytes(noise(0.5) + tone(1.0) + noise(1.0))
    for name, value in (("FAKE_LOG", log), ("FAKE_PCM", pcm), ("FAKE_TEXT", TEXT), ("FAKE_HOLD", "1")):
        monkeypatch.setenv(name, str(value))
    monkeypatch.setenv("FAKE_FRAMES_PER_WRITE", "5")
    home = tmp_path / "speech"
    fake_engine(home)
    (home / "models").mkdir()
    for name in ("en-model", "ja-model"):
        (home / "models" / f"{name}.gguf").write_bytes(MODEL_BLOB)
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"dictation": True}))
    out = io.StringIO()
    tools = Tools(record=str(tool(tmp_path, "pw-record", PW_RECORD)), runtime_dir=str(tmp_path))

    def make(port: int = 9):
        # Never GitHub or Hugging Face from a test: by default downloads go to a closed local port.
        engine = Engine(home, "0.4.1", Log(out), use_scope=False)
        return Dictation(
            Log(out),
            settings,
            home=home,
            tools=tools,
            engine=engine,
            catalog=catalog_at(port),
            download_options=OPTIONS,
        )

    return make, out, pcm, settings, home, log


async def ask(dictation: Dictation, op: str, **fields) -> dict:
    return await dictation.handle(op, fields)


async def follow(dictation: Dictation, session: int) -> list[dict]:
    """Every phase the page would see, waiting as it does."""
    phase, seen = "listening", []
    while phase in ("listening", "transcribing"):
        reply = await ask(dictation, "dictation.wait", session=session, phase=phase, timeoutMs=5000)
        phase = reply["phase"]
        seen.append(reply)
    return seen


def test_a_phrase_is_heard_recognized_and_handed_out_once(setup):
    make, out, _, _, _, log = setup

    async def main():
        dictation = make()
        try:
            started = await ask(dictation, "dictation.start", language="ja")
            assert started == {"ok": True, "session": 1, "model": "ja-model"}
            seen = await follow(dictation, 1)
            again = await ask(dictation, "dictation.wait", session=1, phase="transcribing", timeoutMs=0)
            return seen, again
        finally:
            await dictation.close()

    seen, again = asyncio.run(main())
    assert [s["phase"] for s in seen] == ["transcribing", "done"]
    assert seen[-1]["text"] == TEXT
    assert again["phase"] == "done" and again["text"] == ""  # only once
    text = out.getvalue()
    assert TEXT not in text and "晴" not in text
    assert "dictation 1: listening (default)" in text and "s of speech recognized in" in text and "by ja-model)" in text
    assert "load ja-model.gguf backend=cpu" in log.read_text()


def test_the_model_follows_the_language_and_the_choices():
    catalog = catalog_at(9)
    ready = {"en-model", "ja-model", "any-model"}
    use = lambda language, choices, have=ready: (
        (pick(catalog, language, choices, have) or type("N", (), {"id": None})).id
    )
    assert use("en", {}) == "en-model" and use("ja", {}) == "ja-model" and use("zh", {}) == "ja-model"
    assert use("de", {}) == "any-model"  # nothing for German: the one for any language
    assert use("en", {"en": "any-model"}) == "any-model"
    assert use("ja", {"ja": "en-model"}) == "ja-model"  # a choice that does not serve the language is passed over
    assert use("ja", {"ja": "nope"}) == "ja-model"
    assert use("en", {"en": "en-model"}, {"ja-model"}) is None  # chosen but not downloaded: nothing serves English
    assert use("de", {}, {"en-model"}) is None


def test_pressing_again_stops_and_recognizes_what_was_said(setup, monkeypatch):
    make, _, pcm, *_ = setup
    pcm.write_bytes(noise(0.3) + tone(20.0))
    monkeypatch.setenv("FAKE_REALTIME", "1")

    async def main():
        dictation = make()
        try:
            await ask(dictation, "dictation.start", language="en")
            await asyncio.sleep(0.8)
            assert (await ask(dictation, "dictation.stop", session=1))["ok"]
            return await follow(dictation, 1)
        finally:
            await dictation.close()

    assert asyncio.run(main())[-1] == {"ok": True, "session": 1, "phase": "done", "text": TEXT}


def test_the_speech_level_reaches_the_page_while_listening_and_silence_sends_nothing(setup, monkeypatch):
    make, _, pcm, *_ = setup
    monkeypatch.setenv("FAKE_REALTIME", "1")
    pcm.write_bytes(noise(1.0) + tone(0.6) + noise(3.0))
    assert bar_level(-70, -50) == 0 and bar_level(-50, -50) == 1 and bar_level(-30, -50) == 6 and bar_level(0, -50) == 8

    async def main():
        dictation = make()
        updates = []
        try:
            await ask(dictation, "dictation.start", language="en")
            seq, phase = -1, "listening"
            while phase == "listening":
                reply = await ask(dictation, "dictation.wait", session=1, phase="listening", seq=seq, timeoutMs=5000)
                phase = reply["phase"]
                if phase == "listening":
                    seq = reply["seq"]
                    updates.append(reply["bars"])
        finally:
            await dictation.close()
        return updates

    updates = asyncio.run(main())
    assert updates[0] == [0, 0, 0, 0, 0]  # the first wait answers at once with where the bars are
    assert any(max(bars) >= 3 for bars in updates)  # the tone shows
    assert updates[-1] == [0, 0, 0, 0, 0]  # flat again after it
    assert len(updates) < 25  # the tone and its tail only: 0.6 s is 8 levels, then 5 to go flat


@pytest.mark.parametrize("audio, code", [(noise(5.0), "no-speech"), (zeros(5.0), "mic-silent")])
def test_no_speech_ends_the_session(setup, monkeypatch, audio, code):
    make, _, pcm, *_ = setup
    pcm.write_bytes(audio)
    monkeypatch.setattr(session_module, "NO_SPEECH", 50)

    async def main():
        dictation = make()
        try:
            await ask(dictation, "dictation.start", language="en")
            return await follow(dictation, 1)
        finally:
            await dictation.close()

    assert asyncio.run(main())[-1] == {"ok": True, "session": 1, "phase": "error", "error": code}


def test_off_busy_bad_language_and_what_is_missing(setup):
    make, _, _, settings, home, _ = setup

    async def main():
        dictation = make()
        try:
            assert (await ask(dictation, "dictation.start", language="en; rm"))["error"] == "bad-language"
            assert (await ask(dictation, "dictation.start", language="de"))["error"] == "no-model"
            assert (await ask(dictation, "dictation.start", language="en"))["ok"]
            assert (await ask(dictation, "dictation.start", language="en"))["error"] == "busy"
            await ask(dictation, "dictation.cancel")
            assert (await ask(dictation, "dictation.wait", session=1, phase="listening"))["phase"] == "cancelled"
            (home / "engine" / "0.4.1" / "lib" / "libtranscribe.so").unlink()
            assert (await ask(dictation, "dictation.start", language="en"))["error"] == "no-engine"
            status = await until_settled(dictation)  # the missing engine was fetched again, once (and failed here)
            assert status["engine"] == {"state": "missing", "error": "network"}
            assert status["models"] == {
                "en-model": {"state": "ready"},
                "ja-model": {"state": "ready"},
                "any-model": {"state": "missing"},
            }
            assert (await ask(dictation, "dictation.download", model="nope"))["error"] == "unknown-model"
            settings.write_text(json.dumps({"dictation": False}))
            assert (await ask(dictation, "dictation.start", language="en"))["error"] == "off"
            assert (await ask(dictation, "dictation.download"))["error"] == "off"
        finally:
            await dictation.close()

    asyncio.run(main())


def test_settings_through_the_bridge(setup):
    make, _, _, settings, *_ = setup

    async def main():
        dictation = make()
        call = bridge_for(dictation, settings)
        try:
            assert (await call(op="dictation.start", language="en"))["ok"]
            assert (await call(op="settings.save", settings={"dictation": False}))["ok"]
            assert (await call(op="dictation.wait", session=1, phase="listening"))["phase"] == "cancelled"
            assert (await call(op="settings.save", settings={"dictationModels": {"en": 3}}))["error"] == "bad-settings"
            assert (await call(op="settings.save", settings={"dictationModels": {"english": "x"}}))[
                "error"
            ] == "bad-settings"
            choices = {
                "en": "any-model",
                "zh-Hant": "ja-model",
                "fr": "any-model",
            }  # fr: kept without a keyboard for it
            assert (await call(op="settings.save", settings={"dictation": True, "dictationModels": choices}))["ok"]
            assert json.loads(settings.read_text()) == {"dictation": True, "dictationModels": choices}
            assert (await call(op="dictation.status"))["choices"] == choices
        finally:
            await dictation.close()

    asyncio.run(main())
    assert (asyncio.run(Bridge(Log(io.StringIO())).handle(json.dumps({"id": 2, "op": "dictation.status"}))))[
        "error"
    ] == "unavailable"


def test_the_catalog_for_the_page_has_no_sources(setup):
    make, *_ = setup

    async def main():
        dictation = make()
        try:
            return await ask(dictation, "dictation.catalog")
        finally:
            await dictation.close()

    reply = asyncio.run(main())
    assert reply["ok"] and [m["id"] for m in reply["models"]] == ["en-model", "ja-model", "any-model"]
    assert "127.0.0.1" not in json.dumps(reply) and reply["engine"]["version"] == "0.4.1"


async def until_settled(dictation: Dictation) -> dict:
    for _ in range(200):
        status = await ask(dictation, "dictation.status")
        states = [status["engine"]["state"], *(m["state"] for m in status["models"].values())]
        if "downloading" not in states:
            return status
        await asyncio.sleep(0.05)
    raise AssertionError("still downloading")


def bridge_for(dictation: Dictation, settings):
    bridge = Bridge(Log(io.StringIO()), None, None, settings, dictation=dictation)
    return lambda **f: bridge.handle(json.dumps({"id": 1, **f}))


def test_turning_dictation_on_installs_the_engine_and_then_it_works(setup):
    make, out, _, settings, home, _ = setup
    shutil.rmtree(home / "engine")
    settings.write_text("{}")

    async def main():
        runner, port = await server()
        dictation = make(port)
        call = bridge_for(dictation, settings)
        try:
            assert (await call(op="settings.save", settings={"dictation": True}))["ok"]
            assert (await ask(dictation, "dictation.status"))["engine"]["state"] == "downloading"
            status = await until_settled(dictation)
            assert status["engine"] == {"state": "ready"}
            # On again with the engine in place: nothing more is fetched.
            assert (await call(op="settings.save", settings={"dictation": True}))["ok"]
            assert (await ask(dictation, "dictation.status"))["engine"] == {"state": "ready"}
            await ask(dictation, "dictation.start", language="en")
            return (await follow(dictation, 1))[-1]
        finally:
            await dictation.close()
            await runner.cleanup()

    assert asyncio.run(main())["text"] == TEXT  # through the installed (stand-in) binding
    assert out.getvalue().count("downloading the speech engine") == 1 and "speech engine ready" in out.getvalue()
    assert sorted(p.name for p in (home / "engine").iterdir()) == ["0.4.1"]


def test_models_download_with_progress_and_are_deleted(setup):
    make, out, _, _settings, home, _ = setup

    async def main():
        runner, port = await server(slow=True)
        dictation = make(port)
        try:
            first = await ask(dictation, "dictation.status")
            downloading = await ask(dictation, "dictation.download", model="any-model")
            assert downloading["models"]["any-model"]["state"] == "downloading"
            # The status waits for the next change rather than being polled.
            moved = await ask(dictation, "dictation.status", since=downloading["rev"], timeoutMs=5000)
            assert moved["rev"] > downloading["rev"] and moved["models"]["any-model"]["done"] > 0
            done = await until_settled(dictation)
            assert done["models"]["any-model"] == {"state": "ready"}
            assert (home / "models" / "any-model.gguf").read_bytes() == MODEL_BLOB
            await ask(dictation, "dictation.start", language="ko")  # loads it
            await follow(dictation, 1)
            deleted = await ask(dictation, "dictation.delete", model="any-model")
            assert deleted["models"]["any-model"] == {"state": "missing"} and not dictation.engine.loaded
            # Deleting while it downloads stops the download and leaves nothing.
            await ask(dictation, "dictation.download", model="any-model")
            await asyncio.sleep(0.3)
            await ask(dictation, "dictation.delete", model="any-model")
            return first, await ask(dictation, "dictation.status")
        finally:
            await dictation.close()
            await runner.cleanup()

    first, last = asyncio.run(main())
    assert first["models"]["any-model"] == {"state": "missing"} and last["models"]["any-model"] == {"state": "missing"}
    assert sorted(p.name for p in (home / "models").iterdir()) == ["en-model.gguf", "ja-model.gguf"]
    assert "speech model any-model ready" in out.getvalue() and "speech model any-model deleted" in out.getvalue()


def test_without_network_it_fails_once_and_waits_for_a_retry(setup):
    make, out, _, settings, home, _ = setup
    shutil.rmtree(home / "engine")
    settings.write_text("{}")

    async def main():
        runner, port = await server()
        await runner.cleanup()  # nothing listens there now: no network
        dictation = make(port)
        call = bridge_for(dictation, settings)
        try:
            await call(op="settings.save", settings={"dictation": True})
            failed = await until_settled(dictation)
            for _ in range(5):  # the page asks for the status again and again: no new attempt
                await asyncio.sleep(0.05)
                assert (await ask(dictation, "dictation.status"))["engine"] == failed["engine"]
            runner, port = await server()  # the retry button, once there is a server
            dictation.library.catalog = catalog_at(port)
            assert (await call(op="dictation.download"))["engine"]["state"] == "downloading"
            retried = await until_settled(dictation)
            await runner.cleanup()
            return failed, retried
        finally:
            await dictation.close()

    failed, retried = asyncio.run(main())
    assert failed["engine"] == {"state": "missing", "error": "network"} and retried["engine"] == {"state": "ready"}
    assert out.getvalue().count("downloading the speech engine") == 2
    assert "speech engine download failed (network)" in out.getvalue()


def test_turning_dictation_off_cancels_downloads(setup):
    make, out, _, settings, home, _ = setup

    async def main():
        runner, port = await server(slow=True)
        dictation = make(port)
        call = bridge_for(dictation, settings)
        try:
            await call(op="dictation.download", model="any-model")
            await asyncio.sleep(0.4)
            await call(op="settings.save", settings={"dictation": False})
            return await ask(dictation, "dictation.status")
        finally:
            await dictation.close()
            await runner.cleanup()

    status = asyncio.run(main())
    assert status["models"]["any-model"] == {"state": "missing"} and status["enabled"] is False
    assert sorted(p.name for p in (home / "models").iterdir()) == ["en-model.gguf", "ja-model.gguf"]  # no part left
    assert "any-model ready" not in out.getvalue()


def test_every_session_logs_how_it_ended(setup, monkeypatch):
    make, out, pcm, *_ = setup
    monkeypatch.setenv("FAKE_REALTIME", "1")
    pcm.write_bytes(noise(0.3) + tone(20.0))

    async def main():
        dictation = make()
        try:
            await ask(dictation, "dictation.start", language="en")
            await asyncio.sleep(0.5)
            await ask(dictation, "dictation.cancel")
        finally:
            await dictation.close()

    asyncio.run(main())
    assert out.getvalue().splitlines() == ["dictation 1: listening (default)", "dictation 1: cancelled while listening"]


# --- continuous sessions ---------------------------------------------------------------------------

PHRASES = noise(0.3) + tone(0.5) + noise(0.9) + tone(0.5) + noise(0.9) + tone(0.5) + noise(8.0)


async def follow_continuous(dictation: Dictation, stop_after: int = 99) -> tuple[list, list]:
    """What the page would see: the texts in order, and every reply; it presses stop after `stop_after` texts."""
    seq, phase, texts, seen = -1, "listening", [], []
    while phase in ("listening", "transcribing"):
        reply = await ask(dictation, "dictation.wait", session=1, phase=phase, seq=seq, timeoutMs=5000)
        phase, seq = reply["phase"], reply.get("seq", seq)
        texts += reply.get("texts", [])
        seen.append(reply)
        if phase == "listening" and len(texts) >= stop_after:
            await ask(dictation, "dictation.stop", session=1)
            stop_after = 99
    return texts, seen


@pytest.fixture
def continuous(setup, monkeypatch):
    make, out, pcm, *_ = setup
    pcm.write_bytes(PHRASES)
    monkeypatch.setenv("FAKE_REALTIME", "1")
    return make, out


def test_continuous_types_each_phrase_while_listening_until_stopped(continuous, monkeypatch):
    make, out = continuous
    monkeypatch.setenv("FAKE_TEXTS", "alpha|bravo|charlie")

    async def main():
        dictation = make()
        try:
            assert (await ask(dictation, "dictation.start", language="en", continuous=True))["ok"]
            return await follow_continuous(dictation, stop_after=3)
        finally:
            await dictation.close()

    texts, seen = asyncio.run(main())
    assert texts == ["alpha", "bravo", "charlie"]
    # The first two arrived while it was still listening, the session ending only on stop.
    assert [r["phase"] for r in seen if r.get("texts")][:2] == ["listening", "listening"]
    assert seen[-1]["phase"] == "done" and "text" not in seen[-1]
    assert any(r.get("recognizing") for r in seen)
    log = out.getvalue()
    assert "alpha" not in log and "bravo" not in log
    assert "dictation 1: listening continuously (default)" in log
    assert "dictation 1: phrase 1 done (" in log and "by en-model)" in log
    assert "dictation 1: stopped (3 phrases, 0 dropped)" in log


def test_a_phrase_without_words_is_dropped_and_the_session_goes_on(continuous, monkeypatch):
    make, out = continuous
    monkeypatch.setenv("FAKE_TEXTS", "alpha||charlie")

    async def main():
        dictation = make()
        try:
            await ask(dictation, "dictation.start", language="en", continuous=True)
            return await follow_continuous(dictation, stop_after=2)
        finally:
            await dictation.close()

    texts, seen = asyncio.run(main())
    assert texts == ["alpha", "charlie"] and seen[-1]["phase"] == "done"
    assert "phrase 2 dropped (no words;" in out.getvalue() and "stopped (2 phrases, 1 dropped)" in out.getvalue()


def test_stopping_mid_phrase_still_recognizes_it(continuous, setup, monkeypatch):
    make, _out = continuous
    setup[2].write_bytes(noise(0.3) + tone(20.0))
    monkeypatch.setenv("FAKE_TEXTS", "the end")

    async def main():
        dictation = make()
        try:
            await ask(dictation, "dictation.start", language="en", continuous=True)
            await asyncio.sleep(0.8)
            await ask(dictation, "dictation.stop", session=1)
            return await follow_continuous(dictation)
        finally:
            await dictation.close()

    texts, seen = asyncio.run(main())
    assert texts == ["the end"] and seen[-1]["phase"] == "done"


def test_a_phrase_is_dropped_when_recognition_falls_far_behind(continuous, setup, monkeypatch):
    make, out = continuous
    # Three phrases of about 1 s, the third ending while the first still waits for the helper to load.
    setup[2].write_bytes(noise(0.3) + tone(0.5) + noise(0.7) + tone(0.5) + noise(0.7) + tone(0.5) + noise(3.0))
    monkeypatch.setenv("FAKE_LOAD_SECONDS", "3")
    monkeypatch.setenv("FAKE_TEXTS", "alpha|bravo")
    monkeypatch.setattr(session_module, "MAX_BEHIND", 40_000)  # room for one phrase waiting

    async def main():
        dictation = make()
        try:
            await ask(dictation, "dictation.start", language="en", continuous=True)
            return await follow_continuous(dictation, stop_after=2)
        finally:
            await dictation.close()

    texts, seen = asyncio.run(main())
    assert texts == ["alpha", "bravo"] and seen[-1]["phase"] == "done"
    assert "a phrase dropped (recognition 1 s behind)" in out.getvalue()
    assert "stopped (2 phrases, 1 dropped)" in out.getvalue()


def test_a_failing_helper_ends_a_continuous_session(continuous, monkeypatch):
    make, out = continuous
    monkeypatch.setenv("FAKE_CRASH", "1")

    async def main():
        dictation = make()
        try:
            await ask(dictation, "dictation.start", language="en", continuous=True)
            return await follow_continuous(dictation)
        finally:
            await dictation.close()

    texts, seen = asyncio.run(main())
    assert texts == [] and seen[-1] == {"ok": True, "session": 1, "phase": "error", "error": "helper-failed"}
    assert "dictation 1: helper-failed (0 phrases, 0 dropped)" in out.getvalue()


def test_a_forgotten_mic_stops_by_itself(setup, monkeypatch):
    make, out, pcm, *_ = setup
    pcm.write_bytes(noise(3.0))
    monkeypatch.setattr(session_module, "IDLE_STOP", 50)

    async def main():
        dictation = make()
        try:
            await ask(dictation, "dictation.start", language="en", continuous=True)
            return await follow_continuous(dictation)
        finally:
            await dictation.close()

    texts, seen = asyncio.run(main())
    assert texts == [] and seen[-1]["phase"] == "done"
    assert "dictation 1: idle-stop (0 phrases, 0 dropped)" in out.getvalue()
