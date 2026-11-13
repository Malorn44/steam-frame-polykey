# Changelog

## [0.1.1](https://github.com/Malorn44/steam-frame-polykey/compare/v0.1.0...v0.1.1) (2026-11-13)


### Features

* **emoji:** a kaomoji mode in the emoji picker ([#46](https://github.com/Malorn44/steam-frame-polykey/issues/46)) ([1c68a55](https://github.com/Malorn44/steam-frame-polykey/commit/1c68a559d9b7ba8bfdecf91afab791470d6ec6d6))
* **emoji:** the picker ticks as the laser crosses cells and tabs ([#50](https://github.com/Malorn44/steam-frame-polykey/issues/50)) ([df1c280](https://github.com/Malorn44/steam-frame-polykey/commit/df1c280247370cf10c0f31d5fa66d665a0b37d69))
* **packs:** names in more than one language ([#51](https://github.com/Malorn44/steam-frame-polykey/issues/51)) ([8efff01](https://github.com/Malorn44/steam-frame-polykey/commit/8efff01cfbeb53c7314189b73b9571c0a274abe6))
* **packs:** picker sets are packs ([#52](https://github.com/Malorn44/steam-frame-polykey/issues/52)) ([d27c1a9](https://github.com/Malorn44/steam-frame-polykey/commit/d27c1a92ee50745026a4f500336bb2bcb3003629))
* **ui:** the swipe trail thins and fades along its length ([#41](https://github.com/Malorn44/steam-frame-polykey/issues/41)) ([7c8518f](https://github.com/Malorn44/steam-frame-polykey/commit/7c8518f12584a4b95edd7f6742097e479b96191d))


### Bug Fixes

* **suggest:** a picked alternative of a swiped word adds a space and clears the bar ([#43](https://github.com/Malorn44/steam-frame-polykey/issues/43)) ([bdf6a3e](https://github.com/Malorn44/steam-frame-polykey/commit/bdf6a3e29b22abdf67f3125459b2c8d8d332f5c3))
* **ui:** keep settings lists scrolled when a tap redraws the page ([#38](https://github.com/Malorn44/steam-frame-polykey/issues/38)) ([d74515b](https://github.com/Malorn44/steam-frame-polykey/commit/d74515ba869b397ed1e777556de3c977df50b54c))
* **ui:** scroll a long reading to keep the caret in view ([#39](https://github.com/Malorn44/steam-frame-polykey/issues/39)) ([4826de6](https://github.com/Malorn44/steam-frame-polykey/commit/4826de6ede6f5592502e67f0182e99e13dc3f5af))

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
