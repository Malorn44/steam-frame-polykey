from __future__ import annotations

import fcntl
import io
import os
import shutil
import subprocess
import sys
import tarfile
import threading
import time
from pathlib import Path

import pytest

from polykey import __main__ as cli
from polykey import versions as versions_module
from polykey.versions import VersionError, Versions, fall_back, is_release, mark_started, newer, parse

SIDECAR = Path(__file__).resolve().parents[1]


def install(versions: Versions, *names: str) -> None:
    """Releases in versions/<version>/, laid out as an install leaves them: VERSION and the sidecar."""
    for name in names:
        folder = versions.versions / name
        (folder / "sidecar").mkdir(parents=True)
        (folder / "VERSION").write_text(f"{name}\n", encoding="utf-8")
        (folder / "sidecar" / "run.py").write_text("print('hi')\n", encoding="utf-8")


@pytest.fixture
def versions(tmp_path):
    return Versions(tmp_path / "polykey")


def test_versions_sort_in_semver_order():
    ordered = ["0.1.0-rc.1", "0.1.0-rc.2", "0.1.0-rc.10", "0.1.0", "0.1.1", "0.2.0", "0.10.0", "1.0.0"]
    assert sorted(reversed(ordered), key=parse) == ordered
    assert newer("0.2.0", "0.1.9") and not newer("0.1.0", "0.1.0") and not newer("bad", "0.1.0")
    assert newer("0.1.0", "0.1.0-rc.1") and newer("0.1.0", "garbage")
    assert parse("0.3.1+dev.4.gabc1234") == parse("0.3.1")
    assert (
        is_release("1.2.3") and not is_release("1.2.3+dev.1") and not is_release("v1.2.3") and not is_release("01.2.3")
    )
    assert not is_release("1.2.3-") and not is_release("1.2.3-rc..1")


def test_installed_lists_only_complete_releases(versions):
    install(versions, "0.2.0", "0.1.0")
    (versions.versions / "0.3.0").mkdir()  # no sidecar: not a release yet
    (versions.versions / "notes").mkdir()
    assert versions.installed() == ["0.1.0", "0.2.0"]


def make_tarball(path: Path, version: str, extra=None, top=None) -> Path:
    """A release tarball as release.sh makes it: polykey-<version>/ with VERSION and the sidecar."""
    top = top or f"polykey-{version}"
    files = {
        "VERSION": f"{version}\n",
        "sidecar/run.py": "print('hi')\n",
        "bundle.js": "/* b */",
        "install.sh": "#!/bin/sh\n",
    }
    files.update(extra or {})
    with tarfile.open(path, "w:gz") as tar:
        for name, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(f"{top}/{name}")
            info.size = len(data)
            info.mode = 0o755 if name.endswith(".sh") else 0o644
            tar.addfile(info, io.BytesIO(data))
    return path


def add_member(tarball: Path, member: tarfile.TarInfo) -> None:
    """Rewrite a tarball with one more (empty) member at the end."""
    with tarfile.open(tarball, "r:gz") as old:
        members = [(m, old.extractfile(m).read()) for m in old]
    with tarfile.open(tarball, "w:gz") as tar:
        for info, data in members:
            tar.addfile(info, io.BytesIO(data))
        tar.addfile(member)


def test_unpack_installs_a_release_into_its_own_folder(versions, tmp_path):
    folder = versions.unpack(make_tarball(tmp_path / "r.tar.gz", "0.1.0"), "0.1.0")
    assert folder == versions.versions / "0.1.0"
    assert (folder / "VERSION").read_text() == "0.1.0\n"
    assert os.access(folder / "install.sh", os.X_OK) and not os.access(folder / "bundle.js", os.X_OK)
    assert versions.installed() == ["0.1.0"]
    assert not (versions.versions / "0.1.0.new").exists()


@pytest.mark.parametrize(
    "bad", ["link", "dotdot", "absolute", "top", "two-tops", "version", "no-sidecar", "not-gzip", "big", "too-much"]
)
def test_unpack_refuses_anything_but_plain_files_under_the_release_folder(versions, tmp_path, monkeypatch, bad):
    tarball = tmp_path / "bad.tar.gz"
    if bad == "link":
        link = tarfile.TarInfo("polykey-0.1.0/evil")
        link.type, link.linkname = tarfile.SYMTYPE, "/etc/passwd"
        add_member(make_tarball(tarball, "0.1.0"), link)
    elif bad == "dotdot":
        make_tarball(tarball, "0.1.0", {"../escape": "x"})
    elif bad == "absolute":
        make_tarball(tarball, "0.1.0", top="/tmp/polykey-0.1.0")
    elif bad == "top":
        make_tarball(tarball, "0.1.0", top="something-else")
    elif bad == "two-tops":
        add_member(make_tarball(tarball, "0.1.0"), tarfile.TarInfo("polykey-0.2.0/VERSION"))
    elif bad == "version":
        make_tarball(tarball, "0.1.0", {"VERSION": "0.2.0\n"})
    elif bad == "no-sidecar":
        with tarfile.open(tarball, "w:gz") as tar:
            info = tarfile.TarInfo("polykey-0.1.0/VERSION")
            info.size = 6
            tar.addfile(info, io.BytesIO(b"0.1.0\n"))
    elif bad == "big":  # one file over the cap
        monkeypatch.setattr(versions_module, "MAX_MEMBER", 100)
        make_tarball(tarball, "0.1.0", {"bundle.js": "x" * 101})
    elif bad == "too-much":  # files each under the cap, together over it
        monkeypatch.setattr(versions_module, "MAX_TOTAL", 100)
        make_tarball(tarball, "0.1.0", {"a.js": "x" * 60, "b.js": "x" * 60})
    else:
        tarball.write_bytes(b"not a tarball")
    with pytest.raises(VersionError) as error:
        versions.unpack(tarball, "0.1.0")
    assert error.value.code == "bad-archive"
    assert versions.installed() == []
    assert not (versions.versions / "0.1.0.new").exists()
    assert not (tmp_path / "escape").exists()


def test_unpack_refuses_a_version_that_is_not_a_release(versions, tmp_path):
    with pytest.raises(VersionError) as error:
        versions.unpack(make_tarball(tmp_path / "r.tar.gz", "0.1.0"), "../0.1.0")
    assert error.value.code == "bad-version"


def test_unpacking_the_running_release_again_leaves_it_alone(versions, tmp_path):
    versions.unpack(make_tarball(tmp_path / "r.tar.gz", "0.1.0"), "0.1.0")
    versions.activate("0.1.0")
    marker = versions.versions / "0.1.0" / "speech-in-use"
    marker.write_text("x")
    versions.unpack(make_tarball(tmp_path / "again.tar.gz", "0.1.0"), "0.1.0")
    assert marker.exists() and not (versions.versions / "0.1.0.new").exists()


def test_unpacking_a_release_that_is_not_current_replaces_it(versions, tmp_path):
    versions.unpack(make_tarball(tmp_path / "r.tar.gz", "0.1.0"), "0.1.0")
    (versions.versions / "0.1.0" / "left-over").write_text("x")
    versions.unpack(make_tarball(tmp_path / "again.tar.gz", "0.1.0"), "0.1.0")
    assert not (versions.versions / "0.1.0" / "left-over").exists()
    assert versions.installed() == ["0.1.0"]


def test_activate_points_current_at_the_release_and_remembers_the_one_before(versions):
    install(versions, "0.1.0", "0.2.0")
    versions.activate("0.1.0")
    assert os.readlink(versions.link) == "versions/0.1.0"
    assert versions.current() == "0.1.0" and versions.previous() is None
    versions.activate("0.2.0")
    assert versions.current() == "0.2.0" and versions.previous() == "0.1.0"
    assert not (versions.root / ".current.new").exists()
    with pytest.raises(VersionError) as error:
        versions.activate("0.9.0")
    assert error.value.code == "not-installed" and versions.current() == "0.2.0"


def test_activate_keeps_the_current_release_and_the_one_before(versions):
    install(versions, "0.1.0")
    versions.activate("0.1.0")
    for v in ("0.2.0", "0.3.0", "0.4.0"):
        install(versions, v)
        (versions.versions / f"{v}.new").mkdir()  # left by an interrupted install
        versions.activate(v)
    assert versions.installed() == ["0.3.0", "0.4.0"]
    assert sorted(p.name for p in versions.versions.iterdir()) == ["0.3.0", "0.4.0"]


def test_the_release_still_running_is_never_pruned(versions):
    install(versions, "0.1.0")
    versions.activate("0.1.0")
    for v in ("0.2.0", "0.3.0"):  # the service could not restart, so 0.1.0 still runs
        install(versions, v)
        versions.activate(v, running="0.1.0")
    assert versions.installed() == ["0.1.0", "0.2.0", "0.3.0"]


def test_rollback_goes_back_and_skips_the_release_it_left(versions):
    install(versions, "0.1.0", "0.2.0")
    versions.activate("0.1.0")
    versions.activate("0.2.0")
    assert versions.rollback() == ("0.2.0", "0.1.0")
    assert versions.current() == "0.1.0" and versions.skipped() == "0.2.0"
    assert versions.previous() is None
    with pytest.raises(VersionError) as error:
        versions.rollback()
    assert error.value.code == "no-previous"
    # The release rolled back from stays, to be put back on request; asking for it un-skips it.
    versions.prune()
    assert versions.installed() == ["0.1.0", "0.2.0"]
    versions.activate("0.2.0")
    assert versions.skipped() is None and versions.previous() == "0.1.0"


def test_from_a_dev_deploy_rollback_goes_to_the_newest_release(versions):
    install(versions, "0.1.0", "0.2.0")
    versions.activate("0.2.0")
    versions.dev.mkdir()
    os.symlink("dev", versions.root / "dev-link")
    os.replace(versions.root / "dev-link", versions.link)
    assert versions.current() == "dev" and versions.previous() == "0.2.0"
    assert versions.rollback() == ("dev", "0.2.0")
    assert versions.skipped() is None


def test_a_bad_state_file_is_ignored(versions):
    install(versions, "0.1.0", "0.2.0")
    versions.activate("0.1.0")
    versions.activate("0.2.0")
    assert versions.previous() == "0.1.0"
    for text in ("not json", '["0.1.0"]', '{"previous": "../../etc", "skip": 3}'):
        versions.state_file.write_text(text, encoding="utf-8")
        assert versions.state() == {} and versions.previous() is None and versions.skipped() is None


def hold_lock(versions: Versions, seconds: float) -> threading.Thread:
    """Another writer (install.sh, or the service's updater) holding the lock for `seconds`."""
    versions.lock_file.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(versions.lock_file, os.O_RDWR | os.O_CREAT)
    fcntl.flock(fd, fcntl.LOCK_EX)

    def release() -> None:
        time.sleep(seconds)
        os.close(fd)

    holder = threading.Thread(target=release)
    holder.start()
    return holder


def test_a_second_writer_waits_for_the_first(versions):
    install(versions, "0.1.0", "0.2.0")
    versions.activate("0.1.0")
    holder = hold_lock(versions, 0.3)
    started = time.monotonic()
    versions.activate("0.2.0")
    waited = time.monotonic() - started
    holder.join()
    assert waited >= 0.25 and versions.current() == "0.2.0" and versions.previous() == "0.1.0"


def test_a_writer_gives_up_with_busy_rather_than_write_beside_another(versions, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(versions_module, "LOCK_WAIT", 0.1)
    monkeypatch.setenv("XDG_DATA_HOME", str(versions.root.parent))  # run.py finds the same folder
    install(versions, "0.1.0", "0.2.0")
    versions.activate("0.1.0")
    versions.activate("0.2.0")
    tarball = make_tarball(tmp_path / "r.tar.gz", "0.3.0")
    holder = hold_lock(versions, 1.0)
    try:
        writes = (
            lambda: versions.activate("0.1.0"),
            versions.rollback,
            versions.prune,
            lambda: versions.unpack(tarball, "0.3.0"),
        )
        for write in writes:
            with pytest.raises(VersionError) as error:
                write()
            assert error.value.code == "busy"
        with pytest.raises(SystemExit) as code:
            cli.main(["rollback"])
        assert code.value.code == 3 and "under way" in capsys.readouterr().out
    finally:
        holder.join()
    assert versions.current() == "0.2.0" and versions.previous() == "0.1.0" and versions.skipped() is None
    assert sorted(p.name for p in versions.versions.iterdir()) == ["0.1.0", "0.2.0"]


def test_only_an_installed_release_is_marked_started(versions, tmp_path):
    install(versions, "0.1.0")
    mark_started(versions.versions / "0.1.0")
    assert (versions.versions / "0.1.0" / ".started").is_file()
    assert versions.installed() == ["0.1.0"]
    versions.dev.mkdir()
    for other in (versions.dev, tmp_path):  # a dev deploy or a checkout
        mark_started(other)
        assert not (other / ".started").exists()


def test_a_release_that_never_started_falls_back_once(versions):
    install(versions, "0.1.0", "0.2.0")
    versions.activate("0.1.0")
    versions.activate("0.2.0")
    assert fall_back(versions.versions / "0.1.0") is None  # not the current release
    assert fall_back(versions.versions / "0.2.0") == "0.1.0"
    assert versions.current() == "0.1.0" and versions.skipped() == "0.2.0"
    assert fall_back(versions.versions / "0.1.0") is None  # nothing before it
    assert versions.current() == "0.1.0"


def test_a_release_that_reached_steam_stays_put(versions, tmp_path):
    install(versions, "0.1.0", "0.2.0")
    versions.activate("0.1.0")
    versions.activate("0.2.0")
    mark_started(versions.versions / "0.2.0")
    assert fall_back(versions.versions / "0.2.0") is None and versions.current() == "0.2.0"
    versions.dev.mkdir()
    for other in (versions.dev, tmp_path):  # a dev deploy or a checkout never falls back
        assert fall_back(other) is None
    assert versions.current() == "0.2.0" and versions.skipped() is None


def test_activate_and_rollback_work_when_the_rest_of_the_release_does_not(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    versions = Versions(tmp_path / "polykey")
    install(versions, "0.1.0", "0.2.0")
    versions.activate("0.1.0")
    versions.activate("0.2.0")
    monkeypatch.setitem(sys.modules, "polykey.injector", None)  # importing it fails
    with pytest.raises(SystemExit) as code:
        cli.main(["rollback"])
    assert code.value.code == 0 and versions.current() == "0.1.0"


def test_run_py_activate_and_rollback(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    versions = Versions(tmp_path / "polykey")
    install(versions, "0.1.0", "0.2.0")
    for args in (["activate", "0.1.0"], ["activate", "0.2.0"], ["rollback"]):
        with pytest.raises(SystemExit) as code:
            cli.main(args)
        assert code.value.code == 0
    out = capsys.readouterr().out
    assert "current: 0.2.0" in out and "rolled back from 0.2.0 to 0.1.0; updates skip 0.2.0" in out
    with pytest.raises(SystemExit) as code:
        cli.main(["rollback"])
    assert code.value.code == 3
    assert "no earlier release" in capsys.readouterr().out
    with pytest.raises(SystemExit) as code:
        cli.main(["activate", "0.9.0"])
    assert code.value.code == 3
    assert "0.9.0 is not installed" in capsys.readouterr().out
    with pytest.raises(SystemExit) as code:
        cli.main(["activate"])  # this checkout is no installed release
    assert code.value.code == 3
    assert f"{SIDECAR.parent.name} is not installed" in capsys.readouterr().out


def test_run_py_imports_from_the_release_current_points_at(tmp_path):
    """Started through `current`, run.py imports from versions/<version>/, so a later swap of the link
    never mixes two versions in one process."""
    root = tmp_path / "polykey"
    release = root / "versions" / "0.1.0" / "sidecar"
    (release / "polykey").mkdir(parents=True)
    shutil.copy(SIDECAR / "run.py", release / "run.py")
    (release / "polykey" / "__init__.py").write_text("", encoding="utf-8")
    (release / "polykey" / "__main__.py").write_text(
        "import polykey\n\ndef main():\n    print(polykey.__file__)\n", encoding="utf-8"
    )
    os.symlink("versions/0.1.0", root / "current")
    out = subprocess.run(
        [sys.executable, "-I", "-B", str(root / "current" / "sidecar" / "run.py")],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert Path(out.strip()) == (release / "polykey" / "__init__.py").resolve()


def test_an_installed_release_finds_its_folder_from_where_it_is(tmp_path):
    """`run.py activate` from versions/<version>/ works on the folder it is in, whatever XDG_DATA_HOME
    says, so install.sh (which unpacks to ~/.local/share/polykey) and the service always agree."""
    root = tmp_path / "polykey"
    release = root / "versions" / "0.1.0"
    shutil.copytree(SIDECAR / "polykey", release / "sidecar" / "polykey", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(SIDECAR / "run.py", release / "sidecar" / "run.py")
    (release / "VERSION").write_text("0.1.0\n", encoding="utf-8")
    env = {**os.environ, "XDG_DATA_HOME": str(tmp_path / "elsewhere")}
    out = subprocess.run(
        [sys.executable, "-I", "-B", str(release / "sidecar" / "run.py"), "activate"],
        capture_output=True,
        text=True,
        check=True,
        env=env,
    ).stdout
    assert "current: 0.1.0" in out
    assert os.readlink(root / "current") == "versions/0.1.0"
    assert not (tmp_path / "elsewhere" / "polykey").exists()


@pytest.mark.parametrize(
    "broken",
    ["raise ImportError('broken release')\n", "def main():\n    raise RuntimeError('broken release')\n"],
    ids=["at-import", "in-main"],
)
def test_the_service_falls_back_from_a_release_that_cannot_start(tmp_path, broken):
    """run.py itself: a release whose code fails (at import, or out of main()), started as the service,
    goes back."""
    real = {
        "sidecar/run.py": (SIDECAR / "run.py").read_text(encoding="utf-8"),
        "sidecar/polykey/__init__.py": "",
        "sidecar/polykey/versions.py": (SIDECAR / "polykey" / "versions.py").read_text(encoding="utf-8"),
    }
    versions = Versions(tmp_path / "polykey")
    for v, main in (("0.1.0", "def main():\n    pass\n"), ("0.2.0", broken)):
        tarball = make_tarball(tmp_path / f"{v}.tar.gz", v, {**real, "sidecar/polykey/__main__.py": main})
        versions.unpack(tarball, v)
        versions.activate(v)
    run_py = versions.link / "sidecar" / "run.py"
    result = subprocess.run([sys.executable, "-I", "-B", str(run_py), "run"], capture_output=True, text=True)
    assert result.returncode != 0 and "went back to 0.1.0" in result.stderr
    assert "broken release" in result.stderr  # the failure itself is still raised, for the journal
    assert versions.current() == "0.1.0" and versions.skipped() == "0.2.0"
    # Started by hand (not the service), nothing moves.
    versions.activate("0.2.0")
    result = subprocess.run([sys.executable, "-I", "-B", str(run_py), "probe"], capture_output=True, text=True)
    assert result.returncode != 0 and "went back" not in result.stderr
    assert versions.current() == "0.2.0"


def test_the_service_falls_back_from_a_value_error_too(tmp_path):
    """The real sidecar's code, with a service that raises a ValueError (a JSONDecodeError, say) before
    it reaches Steam: that is the release's failure, not a refused debugger, so it goes back too."""
    versions = Versions(tmp_path / "polykey")
    for v in ("0.1.0", "0.2.0"):
        release = versions.versions / v
        shutil.copytree(
            SIDECAR / "polykey", release / "sidecar" / "polykey", ignore=shutil.ignore_patterns("__pycache__")
        )
        shutil.copy(SIDECAR / "run.py", release / "sidecar" / "run.py")
        (release / "VERSION").write_text(f"{v}\n", encoding="utf-8")
        versions.activate(v)
    with open(versions.versions / "0.2.0" / "sidecar" / "polykey" / "injector.py", "a", encoding="utf-8") as injector:
        injector.write("\n\nasync def run_service(cfg, log, stop):\n    raise ValueError('broken release')\n")
    env = {**os.environ, "HOME": str(tmp_path), "XDG_CONFIG_HOME": str(tmp_path / "config")}
    run_py = versions.link / "sidecar" / "run.py"
    result = subprocess.run([sys.executable, "-I", "-B", str(run_py), "run"], capture_output=True, text=True, env=env)
    assert result.returncode == 1 and "went back to 0.1.0" in result.stderr
    assert "ValueError: broken release" in result.stderr
    assert versions.current() == "0.1.0" and versions.skipped() == "0.2.0"
