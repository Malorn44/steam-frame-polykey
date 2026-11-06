from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from polykey import __main__ as cli
from polykey.versions import VersionError, Versions, is_release, newer, parse

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
