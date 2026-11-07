from __future__ import annotations

import asyncio
import hashlib
import os

from aiohttp import web

from polykey.speech import download as download_module
from polykey.speech.download import GITHUB_HOSTS, HF_HOSTS, Download, Remote, host_allowed

BLOB = os.urandom(3 * 1024 * 1024 + 17)
SHA = hashlib.sha256(BLOB).hexdigest()
SIZE = len(BLOB)


def test_redirects_only_to_the_pinned_hosts_over_https():
    hf = lambda url: host_allowed(url, HF_HOSTS, ("https",))
    assert hf("https://huggingface.co/x") and hf("https://cdn-lfs.hf.co/x") and hf("https://cas-bridge.xethub.hf.co/x")
    assert not hf("http://huggingface.co/x") and not hf("https://evilhuggingface.co/x") and not hf("https://hf.co.evil.com/x")
    assert not hf("https://github.com/x")
    gh = lambda url: host_allowed(url, GITHUB_HOSTS, ("https",))
    assert gh("https://github.com/a/b/releases/download/v1/x.tar.gz") and gh("https://release-assets.githubusercontent.com/x")
    assert not gh("https://huggingface.co/x") and not gh("https://githubusercontent.com.evil.org/x")


async def serve(routes):
    app = web.Application()
    app.add_routes(routes)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"


def fetch(tmp_path, name, routes, size=SIZE, sha=SHA, **kwargs):
    async def main():
        runner, base = await serve(routes)
        try:
            remote = Remote(f"{base}/resolve/{name}", size, sha, ("127.0.0.1",))
            job = Download(remote, tmp_path / "models" / name, schemes=("http",), **kwargs)
            return job, await job.run()
        finally:
            await runner.cleanup()
    return asyncio.run(main())


def redirect(to):
    async def handler(_request):
        raise web.HTTPFound(to)
    return handler


ranges: list = []


async def blob(request):
    """The file, honouring a Range request as Hugging Face's CDN does."""
    header = request.headers.get("Range")
    ranges.append(header)
    if header:
        start = int(header.split("=")[1].rstrip("-"))
        return web.Response(status=206, body=BLOB[start:], headers={"Content-Range": f"bytes {start}-{len(BLOB) - 1}/{len(BLOB)}"})
    return web.Response(body=BLOB)


async def cut(request):
    """Half the file, then the connection drops."""
    response = web.StreamResponse(headers={"Content-Length": str(len(BLOB))})
    await response.prepare(request)
    await response.write(BLOB[: len(BLOB) // 2])
    request.transport.close()
    return response


ROUTES = [
    web.get("/resolve/m.gguf", redirect("/cdn/m.gguf")),
    web.get("/cdn/m.gguf", blob),
    web.get("/resolve/off.gguf", redirect("https://example.com/off.gguf")),
    web.get("/resolve/cut.gguf", cut),
]


def test_follows_an_allowed_redirect_and_verifies(tmp_path):
    seen = []
    job, ok = fetch(tmp_path, "m.gguf", ROUTES, on_progress=lambda: seen.append(1))
    assert ok and job.error is None and job.done == len(BLOB)
    path = tmp_path / "models" / "m.gguf"
    assert path.read_bytes() == BLOB
    assert oct(path.stat().st_mode & 0o777) == "0o600" and oct((tmp_path / "models").stat().st_mode & 0o777) == "0o700"
    assert 3 <= len(seen) <= 102  # about once per percent
    assert list((tmp_path / "models").iterdir()) == [path]


def test_a_wrong_hash_or_size_leaves_nothing(tmp_path):
    job, ok = fetch(tmp_path, "m.gguf", ROUTES, sha="0" * 64)
    assert not ok and job.error == "bad-hash"
    assert list((tmp_path / "models").iterdir()) == []
    job, ok = fetch(tmp_path, "m.gguf", ROUTES, size=len(BLOB) - 1)
    assert not ok and job.error == "bad-size"
    assert list((tmp_path / "models").iterdir()) == []


def test_a_redirect_elsewhere_or_a_missing_file_fails(tmp_path):
    job, ok = fetch(tmp_path, "off.gguf", ROUTES, size=1)
    assert not ok and job.error == "bad-host"
    job, ok = fetch(tmp_path, "none.gguf", ROUTES, size=1)
    assert not ok and job.error == "network"


def test_a_cut_download_keeps_its_part_and_resumes_with_a_range(tmp_path):
    job, ok = fetch(tmp_path, "cut.gguf", ROUTES)
    part = tmp_path / "models" / "cut.gguf.part"
    assert not ok and job.error == "network"
    assert part.read_bytes() == BLOB[: len(BLOB) // 2]
    # The same file, now from a server that sends it all (by range).
    ranges.clear()
    routes = [web.get("/resolve/cut.gguf", blob)]
    job, ok = fetch(tmp_path, "cut.gguf", routes)
    assert ok and ranges == [f"bytes={len(BLOB) // 2}-"]
    assert (tmp_path / "models" / "cut.gguf").read_bytes() == BLOB and not part.exists()


def test_a_server_without_ranges_starts_again(tmp_path):
    part = tmp_path / "models" / "m.gguf.part"
    part.parent.mkdir()
    part.write_bytes(b"x" * 1000)  # not even the right bytes: replaced, as the server sends the whole file

    async def whole(_request):
        return web.Response(body=BLOB)
    _job, ok = fetch(tmp_path, "m.gguf", [web.get("/resolve/m.gguf", whole)])
    assert ok and (tmp_path / "models" / "m.gguf").read_bytes() == BLOB


def test_a_wrong_part_fails_its_hash_and_is_removed(tmp_path):
    part = tmp_path / "models" / "m.gguf.part"
    part.parent.mkdir()
    part.write_bytes(b"x" * 1000)
    job, ok = fetch(tmp_path, "m.gguf", ROUTES)  # resumed by range after the wrong bytes
    assert not ok and job.error == "bad-hash" and not part.exists()


def test_no_space(tmp_path, monkeypatch):
    monkeypatch.setattr(download_module.shutil, "disk_usage", lambda p: type("U", (), {"free": 10})())
    job, ok = fetch(tmp_path, "m.gguf", ROUTES)
    assert not ok and job.error == "no-space"
