# polykey

A modular on-screen keyboard for the Valve Steam Frame. It draws inside Steam's own keyboard popup and sends text through Steam's own key entry point, so it works wherever Steam's keyboard appears.

**Status: milestone 5.** English and Japanese keyboards drawn over Steam's keyboard popup:
- **Keys:** the number row with an Fn layer (Esc, F1–F12), sticky Ctrl, Alt, Frame (Super) and Fn, and full arrows. Hold a key for its alternates.
- **Word suggestions** from a bundled word list, with spelling corrections (helo → hello, teh → the) ranked alongside completions. The method follows frame-jp-keyboard (MIT).
- **English on the Japanese keyboards:** in 英数 (ABC) mode the word waits in the bar like a kana reading, with up to eight suggestions where the candidates go. Space or punctuation sends it, 確定 sends it alone, and a picked suggestion replaces it.
- **Toolbar:** settings (theme, haptics, suggestions), emoji, dictate, copy, cut, paste and menu.
- **Emoji:** Recent, Favorites (drag and drop), skin tones, and your Steam emoticons, stickers and room effects.
- **Japanese:** four keyboards that type into a reading buffer, converted with Anthy (SteamOS's libanthy), which learns from what you send:
  - **12-key:** flick input. Options, worded as in Gboard: 英字入力はQWERTY (ABC mode as QWERTY or flick letters), フリックのみ (off: tapping a key again steps to its next kana), フリックガイドを表示 (flick hints), 候補を左に表示 (candidates on the left, the default).
  - **五十音:** the 50-sound table as keys, read right to left like Gboard's 五十音 layout; tap a kana, ゛゜小 changes the one before. Shares the 12-key's letter and symbol pages.
  - **Romaji:** the English layout with 英数 and かな beside Space; in かな, letters become kana as you type (ka → か), and `, . - [ ]` become 、。ー「」.
  - **Kana (JIS):** the JIS layout, Mac style. Each key has its Latin and kana legends: 英数 types the Latin ones, かな the kana (Shift: the upper legend). ゛ and ゜ join the kana before them. Option: ローマ字入力, where the keys type their Latin legends as romaji. かな while typing shows the reading as カタカナ, then ﾊﾝｶｸ (on the romaji keyboard too).
- **🌐** switches between polykey's keyboards; settings hands over to Steam's own keyboard.

Layouts, keyboards and themes are JSON packs (`packs/`, `schema/pack.schema.json`). A user pack in `~/.config/polykey/packs/<namespace>/` replaces a bundled item with the same id. KDE Desktop Mode gets non-ASCII text by paste.

> Unofficial; not affiliated with Valve. It relies on private Steam internals. When a required Steam object is missing, it does nothing and leaves the stock keyboard alone.

## Develop (WSL)

```sh
npm install
python3 -m venv .venv && .venv/bin/pip install aiohttp==3.9.3 pytest   # aiohttp matches the Frame
npm run check        # typecheck, vitest, pytest, build
```

## Deploy to the Frame

This needs key login (`ssh-copy-id steamos@frame`). It only touches `~/.local/share/polykey/` and `~/.config/systemd/user/polykey.service`. The service is started but not enabled at login.

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

## Layout

```
src/core/       pure logic: catalog types, key handling, key codes, output planning
src/host/steam/ the only Steam-facing TypeScript
src/bridge/     page side of the sidecar bridge
src/main.ts     wiring (bundle entry: entry.ts; read-only report: probe.ts)
src/ui/         the keyboard as DOM
packs/          bundled layouts, keyboards, themes; schema/ their JSON Schema
sidecar/        Python sidecar: CDP injector, bridge, Desktop Mode clipboard (Wayland)
tests/          vitest; sidecar/tests: pytest with fake Steam debugger and fake compositor
scripts/        build.mjs, deploy.sh
contrib/        polykey.service
```

## Credits

- The 12-key's arrangement, flick handling, ゛゜小 table, Anthy binding and undo and backspace icons follow sasaken1102r's [frame-jp-keyboard](https://github.com/sasaken1102r/frame-jp-keyboard) (MIT).
- Many icons are ported from TaiKeid's [Steam Frame Full Keyboard](https://github.com/TaiKeid/steam-frame-full-keyboard) (MIT).
- The romaji table is Mozc's `romanji-hiragana.tsv` (BSD-3-Clause, `packs/ja/LICENSE.mozc`).
- The English word list comes from AOSP (Apache-2.0, `packs/en/LICENSE.words`).
- Emoji data comes from Unicode's `emoji-test.txt` (Unicode License v3, `packs/emoji/LICENSE.unicode`).
