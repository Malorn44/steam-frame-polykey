from __future__ import annotations

import asyncio
import json

import pytest

from fake_speech import PW_DUMP, PW_LINK, PW_RECORD, noise, tone, tool, zeros
from polykey.speech import SpeechError, capture, vad
from polykey.speech.capture import Recorder, Tools, parse_rules, raw_microphone
from polykey.speech.vad import FRAME_BYTES, Segmenter, level_db


def frames(pcm: bytes):
    return [pcm[i : i + FRAME_BYTES] for i in range(0, len(pcm) - FRAME_BYTES + 1, FRAME_BYTES)]


def feed(seg: Segmenter, pcm: bytes) -> list[bytes]:
    return [p for p in map(seg.feed, frames(pcm)) if p is not None]


def test_levels():
    assert level_db(zeros(0.02)) == vad.ZERO_DB
    assert -75 < level_db(noise(0.02)) < -65
    assert -22 < level_db(tone(0.02, 4000)) < -15


def test_a_phrase_ends_after_its_pause_with_pre_roll_and_tail():
    seg = Segmenter()
    phrases = feed(seg, noise(1.0) + tone(1.0) + noise(1.0))
    assert len(phrases) == 1
    seconds = len(phrases[0]) / 2 / vad.RATE
    # 0.3 s before the speech, 1 s of it, 0.2 s after.
    assert seconds == pytest.approx(0.3 + 1.0 + 0.2, abs=0.03)
    assert not seg.in_phrase


def test_pause_shorter_than_the_end_keeps_one_phrase():
    seg = Segmenter()
    phrases = feed(seg, noise(0.5) + tone(0.5) + noise(0.4) + tone(0.5) + noise(1.0))
    assert len(phrases) == 1
    assert len(phrases[0]) / 2 / vad.RATE > 1.5


def test_clicks_and_silence_are_not_phrases():
    seg = Segmenter()
    assert feed(seg, noise(1.0) + tone(0.1) + noise(1.0)) == []
    assert feed(seg, zeros(2.0)) == []
    assert seg.finish() is None


def test_zero_frames_are_silence_and_do_not_move_the_floor():
    seg = Segmenter()
    feed(seg, zeros(1.0))
    assert seg.floor == vad.FLOOR_START_DB and seg.all_zero
    assert feed(seg, tone(0.6) + zeros(0.7))  # a long loud phrase between zeros does not gate itself
    assert not seg.all_zero
    silent = Segmenter()
    feed(silent, zeros(1.0))
    assert silent.all_zero


def test_steady_noise_raises_the_floor_so_it_is_not_speech():
    seg = Segmenter()
    hum = tone(5.0, 150)  # about -47 dB: above the default gate, so it opens a phrase at first
    assert feed(seg, hum) == []  # but not once the floor has caught up
    assert seg.floor > -50
    assert not seg.in_phrase
    assert len(feed(seg, hum[:16000] + tone(1.0, 6000) + hum)) == 1  # speech over the hum still is


def test_finish_returns_the_phrase_so_far_and_long_phrases_are_cut():
    seg = Segmenter()
    feed(seg, noise(0.3) + tone(1.0))
    assert seg.in_phrase
    assert len(seg.finish()) / 2 / vad.RATE == pytest.approx(1.3, abs=0.03)  # pre-roll and speech; no tail yet
    long = Segmenter()
    phrases = feed(long, tone(26.0))
    assert len(phrases) == 1 and len(phrases[0]) / 2 / vad.RATE == pytest.approx(25.0, abs=0.05)


def test_spa_rules():
    assert parse_rules('{ media.class = "Audio/Source", alsa.card = 0 }') == {
        "media.class": "Audio/Source",
        "alsa.card": "0",
    }
    assert parse_rules("nope") == {} and parse_rules(None) == {}


def node(id_, **props):
    return {"id": id_, "type": "PipeWire:Interface:Node", "info": {"props": props}}


def port(node_id, name, direction="out", monitor=False):
    return {
        "id": 900 + len(name),
        "type": "PipeWire:Interface:Port",
        "info": {
            "props": {"node.id": node_id, "port.name": name, "port.direction": direction, "port.monitor": monitor}
        },
    }


SMART = {
    "media.class": "Audio/Source",
    "filter.smart": True,
    "node.link-group": "filter-chain-1",
    "filter.smart.target": '{ media.class = "Audio/Source", device.api = "alsa" }',
}
DUMP = [
    node(40, **{"media.class": "Audio/Source", "device.api": "alsa", "node.name": "alsa_input.mic"}),
    port(40, "capture_FL"),
    port(40, "capture_FR"),
    port(40, "monitor_FL", monitor=True),
    port(40, "playback", "in"),
    node(41, **{"media.class": "Audio/Sink", "device.api": "alsa", "node.name": "alsa_output.speaker"}),
    node(50, **SMART),
    node(51, **{"media.class": "Audio/Source", "device.api": "alsa", "node.link-group": "filter-chain-1"}),
]


def test_raw_microphone_is_the_one_device_the_smart_filters_target():
    assert raw_microphone(DUMP) == ("alsa_input.mic", ["capture_FL", "capture_FR"])
    two = DUMP + [node(42, **{"media.class": "Audio/Source", "device.api": "alsa", "node.name": "usb"})]
    assert raw_microphone(two) is None
    assert raw_microphone([d for d in DUMP if d["id"] != 50]) is None  # no smart filter: default source
    assert raw_microphone("junk") is None


@pytest.fixture
def tools(tmp_path, monkeypatch):
    log = tmp_path / "log"
    log.write_text("")
    pcm = tmp_path / "pcm"
    pcm.write_bytes(noise(0.2) + tone(0.5))
    dump = tmp_path / "dump.json"
    dump.write_text(json.dumps(DUMP))
    for name, value in (("FAKE_LOG", log), ("FAKE_PCM", pcm), ("FAKE_DUMP", dump)):
        monkeypatch.setenv(name, str(value))
    runtime = tmp_path / "run"
    runtime.mkdir()
    return (
        Tools(
            record=str(tool(tmp_path, "pw-record", PW_RECORD)),
            dump=str(tool(tmp_path, "pw-dump", PW_DUMP)),
            link=str(tool(tmp_path, "pw-link", PW_LINK)),
            runtime_dir=str(runtime),
        ),
        log,
        runtime,
    )


async def read_all(recorder: Recorder) -> bytes:
    out = b""
    while (frame := await recorder.read()) is not None:
        out += frame
    return out


def test_records_the_default_source_without_the_manager_socket(tools):
    fake, log, _ = tools

    async def main():
        recorder = Recorder(fake)
        await recorder.start()
        assert recorder.route == "default"
        data = await read_all(recorder)
        await recorder.stop()
        return data

    assert len(asyncio.run(main())) == len(noise(0.2) + tone(0.5))
    assert log.read_text().splitlines() == ["record --raw --rate 16000 --channels 1 --format s16 - remote="]


def test_links_the_raw_microphone_through_the_manager_socket(tools, monkeypatch):
    fake, log, runtime = tools
    (runtime / capture.MANAGER_REMOTE).touch()
    monkeypatch.setenv("FAKE_HOLD", "1")  # a recorder runs until stopped

    async def main():
        recorder = Recorder(fake)
        await recorder.start()
        assert recorder.route == "mic"
        data = b"".join([await recorder.read() for _ in range(35)])
        await recorder.stop()
        return data

    assert asyncio.run(main()) == noise(0.2) + tone(0.5)
    lines = log.read_text().splitlines()
    assert lines[0].startswith(
        "record --raw --rate 16000 --channels 1 --format s16 -P { node.autoconnect = false, node.name = polykey-dictation-"
    )
    assert lines[0].endswith("remote=pipewire-0-manager")
    node_name = lines[0].split("node.name = ")[1].split(" ")[0]
    assert lines[1:] == [
        f"link alsa_input.mic:capture_FL {node_name}:input_MONO",
        f"link alsa_input.mic:capture_FR {node_name}:input_MONO",
    ]


def test_a_silent_linked_recorder_falls_back_to_the_default_source(tools, monkeypatch):
    fake, log, runtime = tools
    (runtime / capture.MANAGER_REMOTE).touch()
    monkeypatch.setenv("FAKE_RECORD_SILENT", "1")
    monkeypatch.setattr(capture, "STALL", 0.3)

    async def main():
        recorder = Recorder(fake)
        await recorder.start()
        route = recorder.route
        await recorder.read()
        await recorder.stop()
        return route

    assert asyncio.run(main()) == "default"
    assert log.read_text().splitlines()[-1].endswith(" - remote=")


def test_a_recorder_that_cannot_start_or_stalls_is_an_error(tools, tmp_path, monkeypatch):
    fake, _, _ = tools

    async def missing():
        await Recorder(Tools(record=str(tmp_path / "nope"), runtime_dir=fake.runtime_dir)).start()

    with pytest.raises(SpeechError) as error:
        asyncio.run(missing())
    assert error.value.code == "no-recorder"

    monkeypatch.setenv("FAKE_HOLD", "1")
    monkeypatch.setattr(capture, "READ_TIMEOUT", 0.3)

    async def stalls():
        recorder = Recorder(fake)
        await recorder.start()
        try:
            await read_all(recorder)
        finally:
            await recorder.stop()

    with pytest.raises(SpeechError) as error:
        asyncio.run(stalls())
    assert error.value.code == "no-microphone"
