import sys
from pathlib import Path

# Import the sidecar package from the checkout, as run.py does on the Frame.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest


@pytest.fixture(autouse=True)
def _no_real_data_dir(tmp_path_factory, monkeypatch):
    """Dictation's files (~/.local/share/polykey/speech) go to a temporary directory in every test, so a
    test that starts the service never touches (or cleans up) the real one."""
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path_factory.mktemp("data")))
