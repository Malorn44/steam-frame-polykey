# polykey

A modular on-screen keyboard for the Valve Steam Frame. It draws inside Steam's own keyboard popup and sends text through Steam's own key entry point, so it works wherever Steam's keyboard appears.

**Status: milestone 5.** English and Japanese keyboards drawn over Steam's keyboard popup:
- **Keys:** the number row with an Fn layer (Esc, F1–F12), sticky Ctrl, Alt, Frame (Super) and Fn, and full arrows. Hold a key for its alternates.
- **Word suggestions** from a bundled word list, with spelling corrections (helo → hello, teh → the) ranked alongside completions. The method follows frame-jp-keyboard (MIT).
- **Swipe typing:** hold the trigger and trace a word across the letters. The best word is typed, with a space before it when it follows a word; two alternatives show beside it in the bar, and picking one replaces it. Backspace right after a swipe takes the word back. The sidecar decodes the path by template matching against the word list, so any layout pack that declares `"features": {"swipe": {"lexicon": …}}` can swipe. It is off by default: Settings → Swipe typing turns it on, per keyboard. The Japanese keyboards offer it for English in 英数 mode (the 12-key's QWERTY ABC page, romaji, JIS), where the swiped word waits in the bar like a typed one.
- **English on the Japanese keyboards:** in 英数 (ABC) mode the word waits in the bar like a kana reading, with up to eight suggestions where the candidates go. Space or punctuation sends it, 確定 sends it alone, and a picked suggestion replaces it.
- **Toolbar:** settings (theme, haptics, suggestions; keyboards; dictation), emoji, dictate (while dictation is on), copy, cut, paste and menu.
- **Dictation** (opt-in, on the Frame's CPU): press the mic, speak, and press again or pause. See [Dictation](#dictation).
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

## Develop (WSL)

```sh
npm install
npm ci --prefix tools/eslint   # ESLint on its own TypeScript 6; the project builds with TypeScript 7
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt   # aiohttp matches the Frame
npm run check        # lint (ESLint, ruff, shellcheck, actionlint), typecheck, vitest, pytest, build
npm run test:install # install.sh end to end: throwaway signed releases, served from localhost
```

## Deploy to the Frame

This needs key login (`ssh-copy-id steamos@frame`). It only touches `~/.local/share/polykey/` and `~/.config/systemd/user/polykey.service`. The service is started but not enabled at login. A deploy goes to `~/.local/share/polykey/dev/`, marked as a dev build by a `DEV` file, and points `current` (the link the service runs) at it. A dev build sends the page's console lines to the journal; a release keeps them out unless `"console": true` is in `~/.config/polykey/settings.json`. Releases installed beside it stay in `versions/<version>/`; `sh ~/.local/share/polykey/current/install.sh --rollback` goes back to the newest one.

```sh
scripts/deploy.sh            # build, copy, restart the service, follow the log
scripts/deploy.sh --fg       # run the sidecar in the foreground; Ctrl-C removes polykey from Steam
scripts/deploy.sh --probe    # read-only report of the Steam objects polykey uses
scripts/deploy.sh --stop     # stop and remove polykey from Steam
```

Set `POLYKEY_HOST` to use another host than `steamos@frame`. polykey won't draw while frame-jp-keyboard is active; stop it first.

Debug from the CDP console (`ssh -L 8080:127.0.0.1:8080 steamos@frame`, then `localhost:8080` → SharedJSContext):

```js
__polykey.debug.status()
__polykey.debug.use('steam/stock')   // or 'en/english'
```

## Dictation

Speech is recognized on the Frame, on its CPU, by [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp); no audio leaves it. Dictation is off until you turn it on in settings → **Dictation**: nothing is downloaded or run before that, and the toolbar has no mic. Audio and transcripts stay in memory: they are never logged or written to disk. The journal gets status codes, model ids and durations only.

- **Use:** press the mic key, speak, then press it again or pause for 0.6 s. While it listens, five bars on the key follow your voice; while the phrase is recognized, an arc circles inside its border (pressing it then gives up on the phrase). English is typed after what you were typing, spaced. On a Japanese keyboard the text goes into the reading for conversion, or is typed at once: that keyboard's **Dictation** option (Candidates, Type at once). In 英数 mode it is English. With no model for the keyboard's language, the mic opens the Dictation tab there.
- **Continuous dictation** (a switch on the Dictation tab): the mic listens until you press it again. Each pause types its phrase while you go on speaking, joined to the one before by a space where the script has them. It stops by itself after a minute without speech.
- **Models:** the Dictation tab lists your keyboards' languages and the models for each, with a speed and accuracy rating (from [Handy](https://github.com/cjpais/Handy)'s benchmarks on a laptop CPU, not measured on the Frame), the download size, and ⓘ for its languages, memory, licence and authors. Tap a model to use it for that language; it downloads first if needed. **Downloaded** lists what is on disk and which of your languages use it; ✕ deletes a model or stops its download. A language uses the model chosen for it, else a downloaded one made for it, else a downloaded Whisper (any language). While the engine, or the model a language waits for, downloads, the mic key is disabled with a progress track along its foot.
- **Engine:** transcribe.cpp 0.4.1's prebuilt Linux aarch64 library from its GitHub release (18 MB), used through its own ctypes binding; nothing is compiled. Only the CPU libraries are installed (never `libggml-vulkan.so`: GPU inference on the Frame drew about 17 W and crashed, per TaiKeid); ggml picks the CPU variant the Frame supports. It runs in a helper process (`sidecar/polykey/speech/worker.py`) with 4 threads, in a systemd scope of its own capped for its model's memory (the service's `MemoryHigh=96M` would throttle it), started on the first phrase and stopped after 60 s unused or when another model is wanted.
- **Microphone:** `pw-record`, linked to the raw microphone where SteamOS's voice filters would mangle speech. The microphone sends silence while the headset is off your head; then dictation ends with `mic-silent`.
- **Downloads:** pinned in `sidecar/polykey/speech/catalog.json` by URL (or Hugging Face repo, revision and file), size and SHA-256; the engine only from github.com and the models only from Hugging Face, over HTTPS (redirects included). A download cut off by the network resumes where it stopped; a file is used only once its size and hash match.
- **Files:** `~/.local/share/polykey/speech/engine/0.4.1/` (`lib/`, `python/`, `licenses/`) and `speech/models/*.gguf`. `deploy.sh` leaves `speech/` alone.

| Model | Languages | Download | Licence |
|---|---|---|---|
| Whisper small | any (99) | 270 MB | Apache-2.0 (OpenAI) |
| Whisper base | any (99) | 85 MB | Apache-2.0 (OpenAI) |
| Parakeet TDT 0.6B v2 | en | 730 MB | CC BY 4.0 (NVIDIA) |
| Parakeet TDT-CTC 110M | en | 135 MB | CC BY 4.0 (NVIDIA) |
| SenseVoice Small | zh, yue, en, ja, ko | 253 MB | FunASR Model License 1.1 (Alibaba) |
| Canary 180M Flash | en, de, es, fr | 218 MB | CC BY 4.0 (NVIDIA) |
| Parakeet TDT 0.6B v3 | 25 European languages | 740 MB | CC BY 4.0 (NVIDIA) |

All are 8-bit GGUF conversions by handy-computer on Hugging Face. Their full attributions (also in `sidecar/polykey/speech/catalog.json`):

- Whisper small: Whisper small by OpenAI (Apache-2.0), converted to GGUF and quantized to 8 bits by handy-computer.
- Whisper base: Whisper base by OpenAI (Apache-2.0), converted to GGUF and quantized to 8 bits by handy-computer.
- Parakeet TDT 0.6B v2: parakeet-tdt-0.6b-v2 by NVIDIA, CC BY 4.0, https://creativecommons.org/licenses/by/4.0/; converted to GGUF and quantized to 8 bits by handy-computer.
- Parakeet TDT-CTC 110M: parakeet-tdt_ctc-110m by NVIDIA, CC BY 4.0, https://creativecommons.org/licenses/by/4.0/; converted to GGUF and quantized to 8 bits by handy-computer.
- SenseVoice Small: SenseVoiceSmall by FunAudioLLM (Alibaba Group), FunASR Model License 1.1, https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE; converted to GGUF and quantized to 8 bits by handy-computer.
- Canary 180M Flash: canary-180m-flash by NVIDIA, CC BY 4.0, https://creativecommons.org/licenses/by/4.0/; converted to GGUF and quantized to 8 bits by handy-computer.
- Parakeet TDT 0.6B v3: parakeet-tdt-0.6b-v3 by NVIDIA, CC BY 4.0, https://creativecommons.org/licenses/by/4.0/; converted to GGUF and quantized to 8 bits by handy-computer.

**Check the engine** once on the Frame, after it and Whisper small have downloaded. It prints which ggml CPU variant it loaded, then the JFK quote ("And so my fellow Americans, ask not…") within a few seconds; random words mean that CPU variant computes wrongly (see Troubleshooting below):

```sh
cd ~/.local/share/polykey/speech
curl -sLO https://raw.githubusercontent.com/ggml-org/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav
python3 -I ~/.local/share/polykey/current/sidecar/polykey/speech/worker.py engine/0.4.1 models/whisper-small-Q8_0.gguf 4 --check jfk.wav
```

**Troubleshooting:** if the check prints garbage, move the newest CPU variants aside so ggml falls back to an older one (`mkdir -p engine/off && mv engine/0.4.1/lib/libggml-cpu-armv9.2_* engine/0.4.1/lib/libggml-cpu-armv8.6_* engine/off/`) and run the check again (code built with i8mm has produced garbage on the Frame; armv8.2 with dot product works). The journal's "speech helper loaded (…, cpu …)" line names the variant in use. Status codes: `no-engine`, `no-model`, `engine-failed`, `model-failed`, `no-recorder`, `no-microphone`, `no-speech`, `mic-silent`, `helper-failed`, `helper-timeout`, and for downloads `network`, `bad-hash`, `bad-size`, `bad-host`, `bad-archive`, `unsupported`, `no-space`.

## Layout

```
src/core/       pure logic: catalog types, key handling, key codes, output planning
src/host/steam/ the only Steam-facing TypeScript
src/bridge/     page side of the sidecar bridge
src/main.ts     wiring (bundle entry: entry.ts; read-only report: probe.ts)
src/ui/         the keyboard as DOM
packs/          bundled layouts, keyboards, themes; schema/ their JSON Schema
sidecar/        Python sidecar: CDP injector, bridge, updater, Desktop Mode clipboard (Wayland), speech/ (dictation)
tests/          vitest; sidecar/tests: pytest with fake Steam debugger and fake compositor
scripts/        build.mjs (and css-minify.mjs, its CSS minification), deploy.sh, release.sh, install.sh
contrib/        polykey.service
```

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
