"""The bundled catalogue (catalog.json): the speech engine's release files and the models dictation can
download, each pinned by URL (or Hugging Face repo, revision and file), size and SHA-256.

It is checked strictly when loaded: a catalogue that does not check out offers nothing, so a bad edit
can never point a download somewhere else or skip its hash.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .download import GITHUB_HOSTS, HF_HOSTS, Remote, host_allowed

PATH = Path(__file__).with_name("catalog.json")
MODEL_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
# A keyboard pack's language ("en", "ja", "zh-Hant"), or "*" for a model that takes any language.
LANGUAGE = re.compile(r"^(\*|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
FILE = re.compile(r"^[A-Za-z0-9_.-]+\.gguf$")
VERSION = re.compile(r"^\d+\.\d+\.\d+$")
ANY = "*"


@dataclass(frozen=True)
class Model:
    id: str
    name: str
    languages: tuple[str, ...]
    remote: Remote
    file: str
    licence: str
    attribution: str
    ram_mb: int
    page: dict  # what the settings page shows: everything but where it comes from (credit: attribution, short)

    def serves(self, language: str) -> bool:
        return ANY in self.languages or language in self.languages


@dataclass(frozen=True)
class Engine:
    version: str
    native: dict[str, Remote]  # by machine (platform.machine())
    python: Remote
    attribution: str


@dataclass(frozen=True)
class Catalog:
    engine: Engine
    models: tuple[Model, ...]

    def model(self, model_id: object) -> Optional[Model]:
        return next((m for m in self.models if m.id == model_id), None)


def _remote(data: dict, hosts: tuple[str, ...]) -> Remote:
    url, size, sha = data["url"], data["size"], data["sha256"]
    if not (
        isinstance(url, str)
        and host_allowed(url, hosts, ("https",))
        and isinstance(size, int)
        and not isinstance(size, bool)
        and size > 0
        and isinstance(sha, str)
        and SHA256.match(sha)
    ):
        raise ValueError("bad file")
    return Remote(url, size, sha, hosts)


def _model(data: dict) -> Model:
    text = lambda key, limit=400: data[key] if isinstance(data[key], str) and 0 < len(data[key]) <= limit else _bad(key)
    languages = data["languages"]
    if not (
        isinstance(languages, list) and languages and all(isinstance(x, str) and LANGUAGE.match(x) for x in languages)
    ):
        raise ValueError("bad languages")
    if not (
        MODEL_ID.match(text("id"))
        and REPO.match(text("repo"))
        and REVISION.match(text("revision"))
        and FILE.match(text("file"))
        and data["engine"] == "transcribe.cpp"
    ):
        raise ValueError("bad model")
    ram = data["ramMB"]
    if not isinstance(ram, int) or isinstance(ram, bool) or not 0 < ram < 16384:
        raise ValueError("bad ramMB")
    url = f"https://huggingface.co/{data['repo']}/resolve/{data['revision']}/{data['file']}"
    remote = _remote({"url": url, "size": data["size"], "sha256": data["sha256"]}, HF_HOSTS)
    handy = data.get("handy")
    if not isinstance(handy, dict):
        raise ValueError("bad handy")
    page = {
        "id": data["id"],
        "name": text("name", 80),
        "languages": languages,
        "size": remote.size,
        "licence": text("licence", 40),
        "attribution": text("attribution"),
        "credit": text("credit", 120),
        "ramMB": ram,
        "notes": text("notes"),
        "handy": handy,
    }
    return Model(
        data["id"],
        page["name"],
        tuple(languages),
        remote,
        data["file"],
        page["licence"],
        page["attribution"],
        ram,
        page,
    )


def _bad(key: str):
    raise ValueError(f"bad {key}")


def parse(data: object) -> Catalog:
    """The catalogue in `data`; ValueError (or KeyError, TypeError) when anything is off."""
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError("unknown catalogue version")
    engine = data["engine"]
    if not (isinstance(engine.get("version"), str) and VERSION.match(engine["version"])):
        raise ValueError("bad engine version")
    native = {machine: _remote(remote, GITHUB_HOSTS) for machine, remote in engine["native"].items()}
    models = tuple(_model(m) for m in data["models"])
    if len({m.id for m in models}) != len(models) or len({m.file for m in models}) != len(models):
        raise ValueError("a model id or file twice")
    return Catalog(
        Engine(
            engine["version"], native, _remote(engine["python"], GITHUB_HOSTS), str(engine.get("attribution", ""))[:400]
        ),
        models,
    )


def load(path: Path = PATH) -> Optional[Catalog]:
    try:
        return parse(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None
