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
from polykey import injector
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


def test_install_unpacks_a_release_into_its_own_folder_and_makes_it_current(versions, tmp_path):
    tarball = make_tarball(tmp_path / "r.tar.gz", "0.1.0")
    odd = tarfile.TarInfo("polykey-0.1.0/odd")
    odd.mode = 0o6777
    add_member(tarball, odd)
    assert versions.install(tarball) == "0.1.0"
    folder = versions.versions / "0.1.0"
    assert (folder / "VERSION").read_text() == "0.1.0\n"
    assert os.access(folder / "install.sh", os.X_OK) and not os.access(folder / "bundle.js", os.X_OK)
    assert (folder / "odd").stat().st_mode & 0o7777 == 0o755  # the data filter's modes
    assert versions.current() == "0.1.0" and os.listdir(versions.versions) == ["0.1.0"]


@pytest.mark.parametrize(
    "bad",
    ["link", "dotdot", "absolute", "top", "not-a-release", "two-tops", "version", "no-sidecar", "not-gzip", "too-much"],
)
def test_install_refuses_anything_but_plain_files_under_the_release_folder(versions, tmp_path, monkeypatch, bad):
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
    elif bad == "not-a-release":  # its folder name is no version: it would land outside versions/
        make_tarball(tarball, "..")
    elif bad == "two-tops":
        add_member(make_tarball(tarball, "0.1.0"), tarfile.TarInfo("polykey-0.2.0/VERSION"))
    elif bad == "version":
        make_tarball(tarball, "0.1.0", {"VERSION": "0.2.0\n"})
    elif bad == "no-sidecar":
        with tarfile.open(tarball, "w:gz") as tar:
            info = tarfile.TarInfo("polykey-0.1.0/VERSION")
            info.size = 6
            tar.addfile(info, io.BytesIO(b"0.1.0\n"))
    elif bad == "too-much":
        monkeypatch.setattr(versions_module, "MAX_TOTAL", 100)
        make_tarball(tarball, "0.1.0", {"a.js": "x" * 60, "b.js": "x" * 60})
    else:
        tarball.write_bytes(b"not a tarball")
    with pytest.raises(VersionError) as error:
        versions.install(tarball)
    assert error.value.code == "bad-archive"
    assert versions.current() is None and os.listdir(versions.versions) == []
    assert not (tmp_path / "escape").exists()


def test_install_refuses_a_tarball_of_another_release_than_asked_for(versions, tmp_path):
    with pytest.raises(VersionError) as error:
        versions.install(make_tarball(tmp_path / "r.tar.gz", "0.1.0"), "0.2.0")
    assert error.value.code == "bad-archive"
    assert versions.current() is None and os.listdir(versions.versions) == []


def test_installing_a_release_again_repairs_it(versions, tmp_path):
    tarball = make_tarball(tmp_path / "r.tar.gz", "0.1.0")
    versions.install(tarball)
    (versions.versions / "0.1.0" / "left-over").write_text("x")
    (versions.versions / "0.1.0" / "bundle.js").unlink()
    versions.install(tarball)
    assert (versions.versions / "0.1.0" / "bundle.js").exists()
    assert not (versions.versions / "0.1.0" / "left-over").exists()
    assert versions.current() == "0.1.0" and versions.previous() is None


def test_a_repair_never_deletes_the_release_in_use_before_its_new_copy_is_in(versions, tmp_path, monkeypatch):
    tarball = make_tarball(tmp_path / "r.tar.gz", "0.1.0")
    versions.install(tarball)
    live, rmtree = versions.versions / "0.1.0", shutil.rmtree

    def careful_rmtree(path, *args, **kwargs):
        assert Path(path) != live, "deleted the release current points at"
        rmtree(path, *args, **kwargs)

    monkeypatch.setattr(shutil, "rmtree", careful_rmtree)
    versions.install(tarball)
    assert (live / "bundle.js").exists() and sorted(os.listdir(versions.versions)) == ["0.1.0"]


def test_a_copy_left_aside_by_an_interrupted_repair_is_pruned(versions, tmp_path):
    install(versions, "0.1.0")
    (versions.versions / "0.1.0.old").mkdir()
    versions.activate("0.1.0")
    assert sorted(os.listdir(versions.versions)) == ["0.1.0"]


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
    versions.activate("0.1.0")
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


def test_a_second_writer_waits_for_the_first(versions, tmp_path):
    install(versions, "0.1.0")
    versions.activate("0.1.0")
    tarball = make_tarball(tmp_path / "r.tar.gz", "0.2.0")
    for write in (lambda: versions.install(tarball), versions.rollback, lambda: versions.activate("0.2.0")):
        holder = hold_lock(versions, 0.3)
        started = time.monotonic()
        write()
        waited = time.monotonic() - started
        holder.join()
        assert waited >= 0.25
    assert versions.current() == "0.2.0" and versions.previous() == "0.1.0" and versions.skipped() is None


def test_a_writer_gives_up_with_busy_rather_than_wait_for_ever(versions, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(versions_module, "LOCK_WAIT", 0.1)
    install(versions, "0.1.0", "0.2.0")
    versions.activate("0.1.0")
    versions.activate("0.2.0")
    tarball = make_tarball(tmp_path / "r.tar.gz", "0.3.0")
    holder = hold_lock(versions, 1.0)
    try:
        for write in (lambda: versions.activate("0.1.0"), versions.rollback, lambda: versions.install(tarball)):
            with pytest.raises(VersionError) as error:
                write()
            assert error.value.code == "busy"
        with pytest.raises(SystemExit) as code:
            cli.main(["rollback", "--root", str(versions.root)])
        assert code.value.code == 1 and "holds the lock" in capsys.readouterr().err
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


def test_run_py_unpack_and_rollback(tmp_path, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "polykey.injector", None)  # they work when the rest of the release does not
    root = str(tmp_path / "polykey")
    for v in ("0.1.0", "0.2.0"):
        with pytest.raises(SystemExit) as code:
            cli.main(["unpack", str(make_tarball(tmp_path / f"{v}.tar.gz", v)), "--root", root])
        assert code.value.code == 0 and capsys.readouterr().out == f"{v}\n"  # the version, and nothing else
    with pytest.raises(SystemExit) as code:
        cli.main(["rollback", "--root", root])
    assert code.value.code == 0
    assert "rolled back from 0.2.0 to 0.1.0; updates skip 0.2.0" in capsys.readouterr().out
    with pytest.raises(SystemExit) as code:
        cli.main(["rollback", "--root", root])
    assert code.value.code == 1
    assert "no earlier release" in capsys.readouterr().err
    (tmp_path / "bad.tar.gz").write_bytes(b"not a tarball")
    with pytest.raises(SystemExit) as code:
        cli.main(["unpack", str(tmp_path / "bad.tar.gz"), "--root", root])
    out, err = capsys.readouterr()
    assert code.value.code == 1 and out == "" and "bad.tar.gz is not a polykey release tarball" in err
    with pytest.raises(SystemExit) as code:
        cli.main(["unpack", "--root", root])
    assert code.value.code == 2 and "needs a release tarball" in capsys.readouterr().err
    assert Versions(Path(root)).current() == "0.1.0"


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
    """`run.py rollback` from versions/<version>/ works on the folder it is in, whatever XDG_DATA_HOME
    says, so install.sh (which runs it through ~/.local/share/polykey/current) and the service agree."""
    versions = Versions(tmp_path / "polykey")
    install(versions, "0.1.0")
    release = versions.versions / "0.2.0"
    shutil.copytree(SIDECAR / "polykey", release / "sidecar" / "polykey", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(SIDECAR / "run.py", release / "sidecar" / "run.py")
    (release / "VERSION").write_text("0.2.0\n", encoding="utf-8")
    versions.activate("0.1.0")
    versions.activate("0.2.0")
    env = {**os.environ, "XDG_DATA_HOME": str(tmp_path / "elsewhere")}
    out = subprocess.run(
        [sys.executable, "-I", "-B", str(versions.link / "sidecar" / "run.py"), "rollback"],
        capture_output=True,
        text=True,
        check=True,
        env=env,
    ).stdout
    assert "rolled back from 0.2.0 to 0.1.0" in out and versions.current() == "0.1.0"
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
        versions.install(make_tarball(tmp_path / f"{v}.tar.gz", v, {**real, "sidecar/polykey/__main__.py": main}))
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


def test_the_service_falls_back_from_a_value_error_too(tmp_path, monkeypatch):
    """A service that raises a ValueError (a JSONDecodeError, say) before it reaches Steam: that is the
    release's failure, not a refused debugger, so it comes out of main() for run.py to go back from."""

    async def broken(cfg, log, stop):
        raise ValueError("broken release")

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setattr(injector, "run_service", broken)
    with pytest.raises(ValueError, match="broken release"):
        cli.main(["run"])
