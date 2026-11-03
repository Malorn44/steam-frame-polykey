"""The converter op with a fake engine (libanthy is on the Frame, not in CI)."""

import asyncio
import io
import json

from polykey.anthy import AnthyUnavailable, Converter
from polykey.bridge import Bridge
from polykey.injector import Log


class FakeAnthy:
    def __init__(self):
        self.calls = []

    def convert(self, reading, lengths=None, resize=None):
        self.calls.append((reading, lengths, resize))
        return [{"reading": reading[:2], "candidates": ["今日", "きょう"]}, {"reading": reading[2:], "candidates": ["は"]}]

    def predict(self, reading):
        return [reading + "ね"]

    def learn(self, reading, lengths, choices, texts):
        self.calls.append(("learn", reading, lengths, choices, texts))
        return True

    def learn_prediction(self, reading, text):
        self.calls.append(("learn-prediction", reading, text))
        return True


def ask(bridge, **request):
    return asyncio.run(bridge.handle(json.dumps({"id": 1, **request})))


def test_convert_and_predict_pass_through():
    engine = FakeAnthy()
    bridge = Bridge(Log(io.StringIO()), converter=Converter(lambda: engine))
    reply = ask(bridge, op="convert", reading="きょうは", lengths=[2, 2], resize=[0, 1])
    assert reply["segments"][0]["candidates"] == ["今日", "きょう"]
    assert engine.calls == [("きょうは", [2, 2], (0, 1))]
    assert ask(bridge, op="predict", reading="きょう")["predictions"] == ["きょうね"]


def test_bad_requests_and_a_missing_library():
    out = io.StringIO()
    bridge = Bridge(Log(out), converter=Converter(lambda: FakeAnthy()))
    assert ask(bridge, op="convert", reading="")["error"] == "bad-reading"
    assert ask(bridge, op="convert", reading="あ" * 65)["error"] == "bad-reading"
    assert ask(bridge, op="convert", reading="あ", lengths=["x"])["error"] == "bad-lengths"

    def missing():
        raise AnthyUnavailable("no libanthy")
    bridge = Bridge(Log(out), converter=Converter(missing))
    assert ask(bridge, op="convert", reading="ひみつ")["error"] == "unavailable"
    assert "ひみつ" not in out.getvalue()  # readings are typed text: never logged


def test_learn_passes_checked_choices_through():
    engine = FakeAnthy()
    bridge = Bridge(Log(io.StringIO()), converter=Converter(lambda: engine))
    assert ask(bridge, op="learn", reading="かんじ", lengths=[3], choices=[0], texts=["漢字"])["ok"] is True
    assert ask(bridge, op="learn", reading="ありが", prediction="ありがとう")["ok"] is True
    assert ask(bridge, op="learn", reading="かんじ", lengths=[3], choices=["x"], texts=["漢字"])["error"] == "bad-learn"
    assert engine.calls == [("learn", "かんじ", [3], [0], ["漢字"]), ("learn-prediction", "ありが", "ありがとう")]
