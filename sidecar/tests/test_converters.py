"""The converter registry: the schema names the same converters, and each request goes to the one it names."""

import asyncio
import io
import json
from pathlib import Path

from polykey.bridge import Bridge
from polykey.converters import CONVERTERS, Converters
from polykey.converters.engine import Converter
from polykey.injector import Log

SCHEMA = Path(__file__).resolve().parents[2] / "packs" / "pack.schema.json"


class Echo:
    """An engine that converts a reading into itself, tagged with its name."""

    def __init__(self, name):
        self.name = name

    def convert(self, reading, lengths=None, resize=None):
        return [{"reading": reading, "candidates": [f"{self.name}:{reading}"]}]

    def predict(self, reading):
        return [f"{self.name}:{reading}…"]


def ask(bridge, **request):
    return asyncio.run(bridge.handle(json.dumps({"id": 1, **request})))


def test_the_schema_names_the_registered_converters():
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    assert schema["$defs"]["keyboard"]["properties"]["converter"]["enum"] == list(CONVERTERS)


def test_a_request_goes_to_the_converter_it_names():
    converters = Converters({"one": Converter(lambda: Echo("one")), "two": Converter(lambda: Echo("two"))})
    bridge = Bridge(Log(io.StringIO()), converters=converters)
    assert ask(bridge, op="convert", converter="two", reading="か")["segments"][0]["candidates"] == ["two:か"]
    assert ask(bridge, op="predict", converter="one", reading="か")["predictions"] == ["one:か…"]


def test_a_request_without_a_known_converter_is_refused_and_not_logged():
    out = io.StringIO()
    bridge = Bridge(Log(out), converters=Converters({"one": Converter(lambda: Echo("one"))}))
    assert ask(bridge, op="convert", reading="ひみつ")["error"] == "unknown-converter"
    assert ask(bridge, op="convert", converter="nope", reading="ひみつ")["error"] == "unknown-converter"
    assert ask(bridge, op="learn", converter=["one"], reading="ひみつ")["error"] == "unknown-converter"
    assert "ひみつ" not in out.getvalue()  # typed text: never logged


def test_without_converters_conversion_is_unavailable():
    bridge = Bridge(Log(io.StringIO()))
    assert ask(bridge, op="convert", converter="anthy", reading="か")["error"] == "unavailable"
