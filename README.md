# polykey

A modular on-screen keyboard for the Valve Steam Frame. It draws inside Steam's own keyboard popup and sends text through Steam's own key entry point, so it works wherever Steam's keyboard appears.

**Status: milestone 5.** English and Japanese keyboards drawn over Steam's keyboard popup:
- **Keys:** the number row with an Fn layer (Esc, F1–F12), sticky Ctrl, Alt, Frame (Super) and Fn, and full arrows. Hold a key for its alternates.
- **Word suggestions** from a bundled word list, with spelling corrections (helo → hello, teh → the) ranked alongside completions. The method follows frame-jp-keyboard (MIT).
- **Swipe typing:** hold the trigger and trace a word across the letters. The best word is typed, with a space before it when it follows a word; two alternatives show beside it in the bar, and picking one replaces it. Backspace right after a swipe takes the word back. The sidecar decodes the path by template matching against the word list, so any layout pack that declares `"features": {"swipe": {"lexicon": …}}` can swipe. It is off by default: Settings → Swipe typing turns it on, per keyboard. The Japanese keyboards offer it for English in 英数 mode (the 12-key's QWERTY ABC page, romaji, JIS), where the swiped word waits in the bar like a typed one.
- **English on the Japanese keyboards:** in 英数 (ABC) mode the word waits in the bar like a kana reading, with up to eight suggestions where the candidates go. Space or punctuation sends it, 確定 sends it alone, and a picked suggestion replaces it.
- **Toolbar:** settings (theme, haptics, suggestions; keyboards; dictation), emoji, dictate (while dictation is on), copy, cut, paste and menu.
- **Dictation** (opt-in, on the Frame's CPU): press the mic, speak, and press again or pause. See [docs/DICTATION.md](docs/DICTATION.md).
- **Emoji:** Recent, Favorites (drag and drop), skin tones, and your Steam emoticons, stickers and room effects.
- **Japanese:** four keyboards that type into a reading buffer, converted with Anthy (SteamOS's libanthy), which learns from what you send:
  - **12-key:** flick input. Options, worded as in Gboard: 英字入力はQWERTY (ABC mode as QWERTY or flick letters), フリックのみ (off: tapping a key again steps to its next kana), フリックガイドを表示 (flick hints), 候補を左に表示 (candidates on the left, the default).
  - **五十音:** the 50-sound table as keys, read right to left like Gboard's 五十音 layout; tap a kana, ゛゜小 changes the one before. Shares the 12-key's letter and symbol pages.
  - **Romaji:** the English layout with 英数 and かな beside Space; in かな, letters become kana as you type (ka → か), and `, . - [ ]` become 、。ー「」.
  - **Kana (JIS):** the JIS layout, Mac style. Each key has its Latin and kana legends: 英数 types the Latin ones, かな the kana (Shift: the upper legend). ゛ and ゜ join the kana before them. Option: ローマ字入力, where the keys type their Latin legends as romaji. かな while typing shows the reading as カタカナ, then ﾊﾝｶｸ (on the romaji keyboard too).
- **🌐** switches between polykey's keyboards; settings hands over to Steam's own keyboard.

Layouts, keyboards and themes are JSON packs (`packs/`, `schema/pack.schema.json`). A user pack in `~/.config/polykey/packs/<namespace>/` replaces a bundled item with the same id. KDE Desktop Mode gets non-ASCII text by paste.

> Unofficial; not affiliated with Valve. It relies on private Steam internals. When a required Steam object is missing, it does nothing and leaves the stock keyboard alone.

## Install

In Desktop Mode, open Konsole and run:

```sh
curl -fsSL https://github.com/Malorn44/steam-frame-polykey/releases/latest/download/install.sh | sh
```

It checks what polykey needs (Python 3.10.12+ with aiohttp, both in SteamOS; Steam's debugger on 127.0.0.1:8080), installs the latest release into `~/.local/share/polykey/`, and starts it now and at every login. No sudo. From then on polykey updates itself: an hour apart it looks for a newer release, and installs one only when its signature checks out against the release key (with `"autoUpdate": false` in `~/.config/polykey/settings.json`, it only reports). Running the script again also updates. The same script, run with an option after `sh -s --`, also does:

```sh
… | sh -s -- --check       # report what's missing; change nothing
… | sh -s -- --rollback    # back to the release before this one
… | sh -s -- --uninstall   # remove polykey (settings and dictation models stay; add --purge to remove them)
```

## More

- [docs/KEYBOARDS.md](docs/KEYBOARDS.md): each keyboard in detail.
- [docs/DICTATION.md](docs/DICTATION.md): dictation, its models, and troubleshooting.
- [docs/DEVELOP.md](docs/DEVELOP.md): set up, deploy to the Frame, debug, and the source layout.

## Credits

- The 12-key's arrangement, flick handling, ゛゜小 table, Anthy binding and undo and backspace icons follow sasaken1102r's [frame-jp-keyboard](https://github.com/sasaken1102r/frame-jp-keyboard) (MIT).
- Many icons are ported from TaiKeid's [Steam Frame Full Keyboard](https://github.com/TaiKeid/steam-frame-full-keyboard) (MIT). Swipe typing follows its behaviour and thresholds (no code copied); the decoder is SHARK2-style template matching (Kristensson and Zhai, 2004). Dictation follows its findings (raw microphone, phrase detection thresholds, CPU only) and the design of its mic key; the code is polykey's own.
- Dictation runs [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) (MIT, with ggml and miniz, MIT; downloaded from its release, not in this repository; its licences are installed in `speech/engine/<version>/licenses/`). The model catalogue's files, revisions, sizes and SHA-256 were seeded from [Handy](https://github.com/cjpais/Handy)'s `catalog.json` (MIT) and checked against Hugging Face, and the speed bars and letter grades follow Handy's (MIT); each model's licence and attribution is in `sidecar/polykey/speech/catalog.json` and shown in settings.
- The romaji table is Mozc's `romanji-hiragana.tsv` (BSD-3-Clause, `packs/ja/LICENSE.mozc`).
- The English word list comes from AOSP (Apache-2.0, `packs/en/LICENSE.words`).
- Emoji data comes from Unicode's `emoji-test.txt` (Unicode License v3, `packs/emoji/LICENSE.unicode`).
- The themes follow editor colour schemes (Catppuccin, Solarized, gruvbox, Nord, Tokyo Night, Rosé Pine, GitHub Primer, Dracula, Night Owl), all MIT; each one's source and any colour of our own is in [`packs/themes/CREDITS.md`](packs/themes/CREDITS.md).

## License

polykey is MIT licensed: see [LICENSE](LICENSE). The code, data, icons and colour schemes it includes from other projects keep their own licences, listed in [docs/THIRD-PARTY-NOTICES.md](docs/THIRD-PARTY-NOTICES.md). Contributions are welcome: see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md), and report security issues as [docs/SECURITY.md](docs/SECURITY.md) describes.
