"""The speech engine and models on disk, their downloads, and the status the page follows.

The engine is fetched once dictation is on (and again if it goes missing, once; after a failure only the
user retries, so nothing loops). Models are fetched when the page asks. Every change bumps `rev`, which
wakes a dictation.status waiting for it.
"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from typing import Awaitable, Callable, Optional, Union

from .catalog import Catalog, Model
from .download import Download
from .install import EngineDownload, installed

ENGINE = "engine"  # the engine's download, among the models'
MAX_WAIT = 20.0


class Library:
    def __init__(self, home: Path, catalog: Optional[Catalog], log, download_options: Optional[dict] = None) -> None:
        self.home = home
        self.catalog = catalog
        self._log = log
        self._download_options = download_options or {}
        self._jobs: dict[str, tuple[Union[Download, EngineDownload], asyncio.Task]] = {}
        self._failed: dict[str, str] = {}  # the last failure per download, until it is tried again
        self._auto = True  # an automatic engine download may still be tried
        self.rev = 0
        self._changed: Optional[asyncio.Event] = None

    def model_path(self, model: Model) -> Path:
        return self.home / "models" / model.file

    def engine_ready(self) -> bool:
        return self.catalog is not None and installed(self.home, self.catalog.engine.version)

    def ready(self) -> set:
        """The ids of the downloaded models."""
        return {m.id for m in self.catalog.models if self.model_path(m).is_file()} if self.catalog else set()

    def _bump(self) -> None:
        self.rev += 1
        if self._changed is not None:
            self._changed.set()
        self._changed = asyncio.Event()

    async def wait(self, since: object, timeout: object) -> None:
        """Until `rev` is not `since` any more, or the timeout (ms, at most MAX_WAIT s)."""
        if not isinstance(since, int) or since != self.rev:
            return
        seconds = min(max(timeout / 1000, 0), MAX_WAIT) if isinstance(timeout, (int, float)) else MAX_WAIT
        if self._changed is None:
            self._changed = asyncio.Event()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._changed.wait(), seconds)

    def _state(self, key: str, ready: bool) -> dict:
        job = self._jobs.get(key)
        if job is not None:
            return {"state": "downloading", "done": job[0].done, "total": job[0].total}
        if ready:
            return {"state": "ready"}
        return {"state": "missing", **({"error": self._failed[key]} if key in self._failed else {})}

    def status(self) -> dict:
        models = (
            {m.id: self._state(m.id, self.model_path(m).is_file()) for m in self.catalog.models} if self.catalog else {}
        )
        return {"rev": self.rev, "engine": self._state(ENGINE, self.engine_ready()), "models": models}

    def page_catalog(self) -> dict:
        """dictation.catalog: the engine and models, without where they come from."""
        if self.catalog is None:
            return {"ok": False, "error": "no-catalog"}
        engine = self.catalog.engine
        native = next(iter(engine.native.values()), None)
        return {
            "ok": True,
            "engine": {
                "version": engine.version,
                "attribution": engine.attribution,
                "size": (native.size if native else 0) + engine.python.size,
            },
            "models": [m.page for m in self.catalog.models],
        }

    def fetch_missing_engine(self) -> None:
        """The engine should be there and is not (never fetched, or deleted): fetch it, once."""
        if self._auto and self.catalog is not None and not self.engine_ready():
            self._auto = False
            self._fetch(ENGINE)

    def enable(self) -> None:
        """Dictation turned on: fetch the engine unless it is in place. This counts as the automatic attempt."""
        self._auto = False
        if self.catalog is not None and not self.engine_ready():
            self._fetch(ENGINE)

    def download(self, model_id: object) -> Optional[str]:
        """Fetch the engine if missing and, if named, a model; an error code, or None."""
        model = self.catalog.model(model_id) if model_id is not None and self.catalog else None
        if model_id is not None and model is None:
            return "unknown-model"
        if not self.engine_ready():
            self._fetch(ENGINE)
        if model is not None and not self.model_path(model).is_file():
            self._fetch(model.id)
        return None

    def _fetch(self, key: str) -> None:
        """Start the download of the engine or of a model, unless it is under way."""
        if key in self._jobs or self.catalog is None:
            return
        options = dict(self._download_options)
        if key == ENGINE:
            job: Union[Download, EngineDownload] = EngineDownload(
                self.catalog.engine, self.home, on_progress=self._bump, **options
            )
            what = "the speech engine"
        else:
            model = self.catalog.model(key)
            assert model is not None
            options.pop("machine", None)
            job = Download(model.remote, self.model_path(model), on_progress=self._bump, **options)
            what = f"speech model {model.id}"
        self._failed.pop(key, None)
        self._log.info(f"dictation: downloading {what}")

        async def run() -> None:
            try:
                ok = await job.run()
            finally:
                self._jobs.pop(key, None)
            if ok:
                if key == ENGINE:
                    self._auto = True  # once it is in place, a later loss is noticed again
                self._log.info(f"dictation: {what} ready")
            else:
                self._failed[key] = job.error or "failed"
                self._log.info(f"dictation: {what} download failed ({job.error})")
            self._bump()

        self._jobs[key] = (job, asyncio.ensure_future(run()))
        self._bump()

    async def _stop_job(self, key: str) -> None:
        entry = self._jobs.pop(key, None)
        if entry is not None and not entry[1].done():
            entry[1].cancel()
            await asyncio.gather(entry[1], return_exceptions=True)

    async def delete(self, model_id: object, unload: Callable[[Path], Awaitable[None]]) -> Optional[str]:
        """Delete a model, or stop its download; `unload` stops a helper that has it loaded."""
        model = self.catalog.model(model_id) if self.catalog else None
        if model is None:
            return "unknown-model"
        await self._stop_job(model.id)
        path = self.model_path(model)
        await unload(path)
        with contextlib.suppress(OSError):
            path.unlink()
        self._failed.pop(model.id, None)
        self._log.info(f"dictation: speech model {model.id} deleted")
        self._bump()
        return None

    async def stop(self) -> None:
        """Stop every download."""
        for key in list(self._jobs):
            await self._stop_job(key)
        self._bump()
