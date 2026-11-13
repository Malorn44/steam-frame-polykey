# Third-party notices

polykey is MIT licensed ([LICENSE](../LICENSE)). It includes work from the projects below, under
their own licences.

## Code and icons (MIT)

Each of these is under the MIT License, whose text follows the list, with its own copyright line:

- **frame-jp-keyboard** (https://github.com/sasaken1102r/frame-jp-keyboard): the 12-key's
  arrangement and flick handling, the ゛゜小 table, the Anthy binding, the spelling corrections, and
  the undo and backspace icons. Copyright (c) 2026 sasaken1102r
- **Steam Frame Full Keyboard** (https://github.com/TaiKeid/steam-frame-full-keyboard): many of the
  icons. Copyright (c) 2026 TaiKeid and contributors
- **Phosphor Icons** (https://github.com/phosphor-icons/core): the "translate" icon (文A).
  Copyright (c) 2023 Phosphor Icons
- **Handy** (https://github.com/cjpais/Handy): the dictation model catalogue's seed data (its files,
  revisions, sizes and SHA-256, from Handy's `catalog.json`, checked against Hugging Face), the speed
  bars and the letter grades. Copyright (c) 2025 CJ Pais
- **The bundled themes' colour schemes**: Catppuccin, Solarized, gruvbox, Nord, Tokyo Night,
  Rosé Pine, GitHub Primer, Dracula and Night Owl, each with its copyright line in
  `packs/themes/CREDITS.md`. (The Steam theme uses Steam's own colours, also noted there.)

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Data

Each with its licence text next to it, in `packs/`:

- The English word list, from AOSP: Apache License 2.0, `packs/en/LICENSE.words`.
- The romaji table, Mozc's `romanji-hiragana.tsv`: BSD-3-Clause, `packs/ja/LICENSE.mozc`.
- Emoji data, Unicode's `emoji-test.txt`: Unicode License v3, `packs/emoji/LICENSE.unicode`.
- Kaomoji, chosen from [kaomojikan/kaomoji-data](https://github.com/kaomojikan/kaomoji-data): MIT, `packs/emoji/LICENSE.kaomoji`.

## Followed, not copied

polykey's own code does these, following others' work:

- **Swipe typing** follows Steam Frame Full Keyboard's behaviour and thresholds; no code is copied.
  Its decoder is SHARK2-style template matching (Kristensson and Zhai, 2004).
- **Dictation** follows Steam Frame Full Keyboard's findings (the raw microphone, the phrase detection
  thresholds, CPU only) and the design of its mic key.
- **Hangul composition** follows the Unicode Standard's Hangul syllable composition (section 3.12,
  "Conjoining Jamo Behavior"): a syllable's code point is computed from its jamo's places in Unicode's
  order. The **2-set (두벌식) layout** is the Korean standard KS X 5002. Both are standards, followed;
  no code or data is copied from any keyboard.

## Downloaded on request, not included

Dictation's engine, transcribe.cpp (MIT, with ggml and miniz), and its speech models are downloaded
only when dictation is turned on. Their licences are installed with them
(`~/.local/share/polykey/speech/engine/<version>/licenses/`), and each model's licence and
attribution is shown in Settings → Dictation and listed in [DICTATION.md](DICTATION.md#models).
