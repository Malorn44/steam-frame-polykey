"""The speech engine's installation from its release archives, and the bundled catalogue."""
from __future__ import annotations

import copy
import io
import json
import tarfile
import zipfile
from pathlib import Path

import pytest

from polykey.speech import SpeechError, catalog as catalog_module
from polykey.speech.catalog import ANY, parse
from polykey.speech.install import installed, unpack


def tar_of(path: Path, files: dict, links: tuple = ()) -> Path:
    with tarfile.open(path, "w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        for name, target in links:
            info = tarfile.TarInfo(name)
            info.type, info.linkname = tarfile.SYMTYPE, target
            tar.addfile(info)
    return path


def wheel_of(path: Path, files: dict) -> Path:
    with zipfile.ZipFile(path, "w") as whl:
        for name, data in files.items():
            whl.writestr(name, data)
    return path


TOP = "transcribe-native-linux-aarch64-cpu-vulkan/"
NATIVE = {TOP + "libtranscribe.so": b"t", TOP + "libggml.so": b"g", TOP + "libggml-base.so": b"b",
          TOP + "libggml-cpu-armv8.2_1.so": b"c", TOP + "libggml-vulkan.so": b"v" * 100,
          TOP + "contract.json": json.dumps({"version": "0.4.1"}).encode(),
          TOP + "licenses/LICENSE": b"MIT", TOP + "licenses/ggml/LICENSE": b"MIT ggml",
          TOP + "../escape.so": b"x", "/abs/libx.so": b"x", TOP + "sub/libdeep.so": b"x"}
WHEEL = {"transcribe_cpp/__init__.py": b"# binding", "transcribe_cpp/_abi.py": b"#", "transcribe_cpp/py.typed": b"",
         "transcribe_cpp-0.4.1.dist-info/licenses/LICENSE": b"MIT", "transcribe_cpp-0.4.1.dist-info/RECORD": b"",
         "../evil.py": b"x", "transcribe_cpp/sub/evil.py": b"x"}


def test_unpacks_only_the_cpu_libraries_and_the_binding(tmp_path):
    target = tmp_path / "engine" / "0.4.1"
    unpack(tar_of(tmp_path / "n.tgz", NATIVE, links=((TOP + "libggml-cpu-armv9.2_1.so", "/etc/passwd"),)),
           wheel_of(tmp_path / "w.whl", WHEEL), target, "0.4.1")
    files = sorted(str(p.relative_to(target)) for p in target.rglob("*") if p.is_file())
    assert files == ["lib/contract.json", "lib/libggml-base.so", "lib/libggml-cpu-armv8.2_1.so", "lib/libggml.so",
                     "lib/libtranscribe.so", "licenses/ggml", "licenses/transcribe.cpp", "licenses/transcribe_cpp",
                     "python/transcribe_cpp/__init__.py", "python/transcribe_cpp/_abi.py", "python/transcribe_cpp/py.typed"]
    assert installed(tmp_path, "0.4.1") and not (tmp_path / "escape.so").exists()


def test_an_incomplete_or_mismatched_archive_installs_nothing(tmp_path):
    target = tmp_path / "engine" / "0.4.1"
    wheel = wheel_of(tmp_path / "w.whl", WHEEL)
    no_lib = {k: v for k, v in NATIVE.items() if not k.endswith("libtranscribe.so")}
    for native, version in ((no_lib, "0.4.1"), (NATIVE, "0.5.0")):
        with pytest.raises(SpeechError):
            unpack(tar_of(tmp_path / "n.tgz", native), wheel, target, version)
        assert not target.exists() and list((tmp_path / "engine").iterdir()) == []


# --- the catalogue ---------------------------------------------------------------------------------

def test_the_bundled_catalogue_loads_and_pins_everything():
    catalog = catalog_module.load()
    assert catalog is not None and catalog.engine.version == "0.4.1"
    assert set(catalog.engine.native) == {"aarch64"}
    for remote in (*catalog.engine.native.values(), catalog.engine.python):
        assert remote.url.startswith("https://github.com/handy-computer/transcribe.cpp/releases/download/v0.4.1/")
    ids = [m.id for m in catalog.models]
    assert ids == ["whisper-small", "whisper-base", "parakeet-tdt-0.6b-v2", "parakeet-tdt-ctc-110m", "sensevoice-small",
                   "canary-180m-flash", "parakeet-tdt-0.6b-v3"]
    for model in catalog.models:
        assert model.remote.url.startswith("https://huggingface.co/handy-computer/") and "/resolve/" in model.remote.url
        assert model.remote.hosts == ("huggingface.co", "hf.co") and model.attribution and model.licence
        assert "nc" not in model.licence.lower()  # nothing non-commercial
        assert "url" not in json.dumps(model.page) and "sha256" not in model.page  # the page gets no sources
    assert catalog.model("whisper-small").serves("ja") and ANY in catalog.model("whisper-base").languages
    assert catalog.model("sensevoice-small").serves("ja") and not catalog.model("parakeet-tdt-0.6b-v2").serves("ja")
    cc = [m.id for m in catalog.models if m.licence == "CC-BY-4.0"]
    assert cc and all("CC BY 4.0" in catalog.model(i).attribution for i in cc)


def test_a_catalogue_that_does_not_check_out_offers_nothing():
    good = json.loads(catalog_module.PATH.read_text(encoding="utf-8"))
    parse(good)
    breaks = [
        lambda d: d["models"][0].update(sha256="abc"),
        lambda d: d["models"][0].update(repo="../../x"),
        lambda d: d["models"][0].update(size=-1),
        lambda d: d["models"][0].update(languages=["english"]),
        lambda d: d["engine"]["python"].update(url="https://example.com/x.whl"),
        lambda d: d["engine"]["native"]["aarch64"].update(url="http://github.com/x"),
        lambda d: d["models"].append(d["models"][0]),
        lambda d: d.update(version=2),
    ]
    for change in breaks:
        data = copy.deepcopy(good)
        change(data)
        with pytest.raises((ValueError, KeyError, TypeError)):
            parse(data)
