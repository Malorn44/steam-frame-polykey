# Changelog

## 0.1.0 (2026-11-07)

The first release of polykey, an on-screen keyboard for the Valve Steam Frame. It draws inside Steam's own keyboard popup and types through Steam's own key entry point, so it works wherever Steam's keyboard appears.

### Install

In Desktop Mode, open Konsole and run:

```sh
curl -fsSL https://github.com/Malorn44/steam-frame-polykey/releases/latest/download/install.sh | sh
```

No sudo. polykey draws through Steam's debugger, and talks to it on 127.0.0.1 only. If the installer says the debugger isn't answering, turn on Steam → Settings → Developer → Enable CEF remote debugging.

### What's in it

- **English and Japanese keyboards.**
  - English: a full layout with an Fn layer (Esc, F1–F12), sticky Ctrl, Alt, Frame and Fn, and arrows. Hold a key for its alternates.
  - Japanese: 12-key flick, 五十音, romaji and kana (JIS), converted to kanji with Anthy.
  - 🌐 switches between your keyboards.
- **Word suggestions** with spelling corrections (teh → the), and **swipe typing**, off until you turn it on per keyboard.
- **Offline dictation:** speech is recognized on the Frame's own CPU, and no audio leaves it. Pick a model per language in settings.
- **Emoji 15.1** with Recent, Favorites and skin tones, plus your **Steam emoticons, stickers and room effects**.
- **A toolbar** with copy, cut, paste, the context menu, emoji, dictation and settings.
- **17 themes**, and your own layouts, keyboards and themes as JSON packs.
- **Signed updates that install themselves.**
  - polykey looks for a new release every hour and installs only what the release key signed. The new release starts once the keyboard has been closed for a few seconds.
  - Settings → General shows what the updater found, with buttons to install, restart, go back or check again. You can also turn automatic updates off there.
  - A release that can't start goes back to the one before it by itself.

### Good to know

- **Steam's debugger and your network:** on the Frame, turning on CEF remote debugging also opens Steam's debugger to your local network on port 8081. That's a SteamOS service, not polykey, and anyone on the same network could read what you type. Close it with `sudo systemctl mask --now steam-web-debug-portforward.service`. polykey keeps working, because it only uses 127.0.0.1. The installer warns you while the port is open.
- Unofficial, and not affiliated with Valve. polykey relies on private Steam internals: if a Steam object it needs is missing, it does nothing and leaves Steam's own keyboard alone.
- Docs: [keyboards](https://github.com/Malorn44/steam-frame-polykey/blob/main/docs/KEYBOARDS.md), [dictation](https://github.com/Malorn44/steam-frame-polykey/blob/main/docs/DICTATION.md), [your own packs](https://github.com/Malorn44/steam-frame-polykey/blob/main/docs/PACKS.md), [how releases are built and signed](https://github.com/Malorn44/steam-frame-polykey/blob/main/docs/RELEASING.md). Report security issues privately, as [SECURITY.md](https://github.com/Malorn44/steam-frame-polykey/blob/main/docs/SECURITY.md) describes.
