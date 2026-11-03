from __future__ import annotations

import asyncio

import pytest

from fake_wayland import FakeCompositor
from polykey import desktop
from polykey.desktop import SECRET_HINT_MIME, DataControl, DesktopPaste, DesktopUnavailable, parse_cardinal


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def socket_path(tmp_path):
    return tmp_path / "wayland-0"


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(desktop, "SETTLE_SECONDS", 0.01)
    monkeypatch.setattr(desktop, "AFTER_PASTE_SECONDS", 0.01)


def test_parse_cardinal():
    assert parse_cardinal("GAMESCOPE_FOCUSED_WINDOW(CARDINAL) = 77594624\n") == 77594624
    assert parse_cardinal("_NET_WM_PID(CARDINAL) = 46556") == 46556
    assert parse_cardinal("GAMESCOPE_FOCUSED_WINDOW:  not found.") is None


def test_reads_the_current_clipboard_and_primary(socket_path):
    async def main():
        fake = await FakeCompositor(socket_path).start()
        clipboard = DataControl(socket_path)
        try:
            await clipboard.ensure()
            assert await clipboard.read("selection") == "old clipboard"
            assert await clipboard.read("primary") == "old primary"
        finally:
            clipboard.close()
            fake.stop()
    run(main())


def test_paste_offers_the_text_marked_secret_then_restores(socket_path):
    async def main():
        fake = await FakeCompositor(socket_path).start()
        paste = DesktopPaste(socket_path)
        try:
            await paste.prepare("テスト")
            assert await fake.paste("selection") == "テスト"
            assert await fake.paste("primary") == "テスト"
            assert SECRET_HINT_MIME in fake.client_mimes("selection")
            assert await fake.paste("selection", SECRET_HINT_MIME) == "secret"
            assert await paste.wait(1.0) is True
            assert await fake.paste("selection") == "old clipboard"
            assert await fake.paste("primary") == "old primary"
        finally:
            paste.clipboard.close()
            fake.stop()
    run(main())


def test_a_secret_hint_read_does_not_count_as_a_paste(socket_path):
    async def main():
        fake = await FakeCompositor(socket_path).start()
        paste = DesktopPaste(socket_path)
        try:
            await paste.prepare("テスト")
            await fake.paste("selection", SECRET_HINT_MIME)  # a clipboard manager checking the hint
            assert await paste.wait(0.2) is False
        finally:
            paste.clipboard.close()
            fake.stop()
    run(main())


def test_no_paste_still_restores(socket_path):
    async def main():
        fake = await FakeCompositor(socket_path).start()
        paste = DesktopPaste(socket_path)
        try:
            await paste.prepare("テスト")
            assert await paste.wait(0.1) is False
            assert await fake.paste("selection") == "old clipboard"
        finally:
            paste.clipboard.close()
            fake.stop()
    run(main())


def test_an_empty_clipboard_is_cleared_again(socket_path):
    async def main():
        fake = await FakeCompositor(socket_path, selection=None, primary=None).start()
        paste = DesktopPaste(socket_path)
        try:
            await paste.prepare("テスト")
            await paste.wait(0.1)
            assert fake.owner["selection"] is None
            assert fake.owner["primary"] is None
        finally:
            paste.clipboard.close()
            fake.stop()
    run(main())


def test_restores_by_itself_when_wait_never_comes(socket_path, monkeypatch):
    monkeypatch.setattr(desktop, "AUTO_RESTORE_SECONDS", 0.1)

    async def main():
        fake = await FakeCompositor(socket_path).start()
        paste = DesktopPaste(socket_path)
        try:
            await paste.prepare("テスト")
            await asyncio.sleep(0.3)
            assert await fake.paste("selection") == "old clipboard"
        finally:
            paste.clipboard.close()
            fake.stop()
    run(main())


def test_back_to_back_pastes_keep_the_original_clipboard(socket_path):
    async def main():
        fake = await FakeCompositor(socket_path).start()
        paste = DesktopPaste(socket_path)
        try:
            for word in ("テスト", "かな", "漢字"):
                await paste.prepare(word)
                assert await fake.paste("selection") == word
                assert await paste.wait(1.0) is True
            # After three rounds, our own restored copy is what gets read and restored each time.
            assert await fake.paste("selection") == "old clipboard"
        finally:
            paste.clipboard.close()
            fake.stop()
    run(main())


def test_unavailable_without_a_socket_or_data_control(socket_path):
    async def main():
        with pytest.raises(DesktopUnavailable) as missing:
            await DataControl(socket_path).ensure()
        assert missing.value.kind == "no-desktop-socket"
        fake = await FakeCompositor(socket_path, data_control=False).start()
        try:
            with pytest.raises(DesktopUnavailable) as no_protocol:
                await DataControl(socket_path).ensure()
            assert no_protocol.value.kind == "no-data-control"
        finally:
            fake.stop()
    run(main())


def test_without_primary_selection_support_only_the_clipboard_is_used(socket_path):
    async def main():
        fake = await FakeCompositor(socket_path, version=1).start()
        paste = DesktopPaste(socket_path)
        try:
            await paste.prepare("テスト")
            assert await fake.paste("selection") == "テスト"
            assert fake.owner["primary"] == ("app", "old primary")
            await paste.wait(1.0)
        finally:
            paste.clipboard.close()
            fake.stop()
    run(main())
