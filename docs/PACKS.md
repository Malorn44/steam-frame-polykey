# Packs

polykey's layouts, keyboards, themes and picker sets are JSON files called packs, and you can add your own.

## Where they go

- polykey's own packs are in [`packs/`](../packs/), one folder per namespace: `en`, `ja`, `themes` and so on.
- Yours go on the Frame in `~/.config/polykey/packs/<namespace>/`, in a namespace of your own (`mine` in the examples below).
- Each file holds one item. Its `id` is `<namespace>/<name>`, in lower-case letters, digits and `-`, and starts with its folder's name. A language's `id` is its code alone (`ja`), and it is `language.json` in the folder of that name.
- An item with the same id as a bundled one replaces it. Any other id adds a new one.
- New keyboards show up in Settings → Keyboards, under their language. New themes show up in the theme picker. New picker sets show up in the emoji picker.

polykey reads packs each time it starts in Steam. After you change one, restart it:

```sh
systemctl --user restart polykey
```

A file with a mistake is skipped, never fatal. Its error shows at the foot of the Settings tab and in the journal (`journalctl --user -u polykey`). polykey reads up to 256 of your pack files, of up to 256 KiB each.

## Kinds

Every item has `schemaVersion` (1), `kind`, `id` and `name`. [`packs/pack.schema.json`](../packs/pack.schema.json) describes every field.

- **theme:** the colours. `surface`, `key`, `keyText`, `modifier` and `accent` are required, and the other colours fall back to them. Add `"tone": "light"` for a light theme.
- **layout:** the keys, row by row, and the toolbar above them. A layout can `extends` another and replace only some of its rows.
- **keyboard:** a layout and what typing on it does: its language, its word list for suggestions, the options it offers in settings, and, if it composes in the bar, its composer, the table that composer reads and its converter. A keyboard can `extends` another too.
- **table:** a romaji table (ka → か), the cycles of the ゛゜小 key, or how Hangul jamo compose.
- **picker:** a set the emoji picker shows: categories of things to tap and type. Emoji and kaomoji are two of them.
- **language:** what the keyboards in one language call their letters, and the words their bar shows while you compose (変換, 確定).

A `name` is a string, or one name per language:

```json
"name": {"en": "Midnight", "ja": "ミッドナイト", "pt-BR": "Meia-noite"}
```

- The keys are language codes (`en`, `ja`, `pt-BR`), and there is at least one.
- polykey shows the name for the current keyboard's language: that code's, then its base language's (`pt-BR` falls back to `pt`), then `en`, then the first one written.
- A list of keyboards (Settings → Keyboards, holding 🌐) names each keyboard in its own language.

The bundled packs are the best examples: [`packs/themes/`](../packs/themes/), [`packs/en/`](../packs/en/), [`packs/ja/`](../packs/ja/) and [`packs/emoji/`](../packs/emoji/).

## A theme

Save this as `~/.config/polykey/packs/mine/midnight.json`, restart polykey and pick Midnight:

```json
{
 "schemaVersion": 1,
 "kind": "theme",
 "id": "mine/midnight",
 "name": "Midnight",
 "colors": {
  "surface": "#101820",
  "key": "#1c2833",
  "keyText": "#e8eef2",
  "modifier": "#26333f",
  "accent": "#4fa3e0"
 }
}
```

## A layout and a keyboard

A QWERTZ keyboard takes two files. The layout extends the English one and replaces rows 1 and 3 (rows count from 0 at the top). Save it as `~/.config/polykey/packs/mine/qwertz-layout.json`:

```json
{
 "schemaVersion": 1,
 "kind": "layout",
 "id": "mine/qwertz-layout",
 "name": "QWERTZ",
 "extends": "en/qwerty",
 "rows": {
  "1": [{"type": "key", "key": "Tab", "w": 1.5}, "q", "w", "e", "r", "t", "z", "u", "i", "o", "p",
        {"type": "char", "char": "[", "shift": "{"}, {"type": "char", "char": "]", "shift": "}"},
        {"type": "char", "char": "\\", "shift": "|", "w": 1.5}],
  "3": [{"type": "mod", "mod": "shift", "w": 2.25}, "y", "x", "c", "v", "b", "n", "m",
        {"type": "char", "char": ",", "shift": "<"}, {"type": "char", "char": ".", "shift": ">"},
        {"type": "char", "char": "/", "shift": "?", "alone": {"w": 1.25}},
        {"type": "key", "key": "ArrowUp", "alone": {"w": 1.25}},
        {"type": "mod", "mod": "shift", "w": 1.75, "alone": {"w": 1.25}}]
 }
}
```

A plain string is a key that types it. Every other key is an object with a `type`, as in [`packs/en/qwerty.json`](../packs/en/qwerty.json). A key is 1 wide unless its `w` says otherwise, and every row must be as wide as the first.

The keyboard extends the English one, so it keeps its word suggestions and swipe typing, and only changes the layout. Save it as `~/.config/polykey/packs/mine/qwertz.json`:

```json
{
 "schemaVersion": 1,
 "kind": "keyboard",
 "id": "mine/qwertz",
 "name": "QWERTZ",
 "extends": "en/english",
 "layout": "mine/qwertz-layout"
}
```

Restart polykey, then add QWERTZ in Settings → Keyboards.

## A language

A keyboard's `language` is a code (`ja`, `ko`, `pt-BR`), and the `language` pack with that code fills in what the keyboard leaves out. Its `id` is the code, and its file is `language.json` in the folder of that name. This is polykey's Japanese, [`packs/ja/language.json`](../packs/ja/language.json):

```json
{
 "schemaVersion": 1,
 "kind": "language",
 "id": "ja",
 "name": {"en": "Japanese", "ja": "日本語"},
 "letters": "あいう",
 "labels": {"convert": "変換", "next": "次変換", "confirm": "確定", "hiragana": "かな", "katakana": "カナ", "halfwidth": "ﾊﾝｶｸ"},
 "idleHint": "入力すると、ここに変換候補が出ます"
}
```

- `letters`: what the language's own letters are called. The keys back to the letters read it in a keyboard's first mode. A mode's own `letters` wins, and a Latin mode without any reads ABC.
- `labels`: the words on the bar's keys while something is composed, by the names its composer gives them. The kana composer's names are `convert` (Space), `next` (Space while converting), `confirm` (Enter), and `hiragana`, `katakana` and `halfwidth` (the form the かな key goes to). `confirm` is Enter's word too while an English word waits in a Latin mode. A key whose name is left out keeps its own label.
- `idleHint`: shown where candidates appear while there are none. A keyboard's `strings.idleHint` wins.
- `dictation`: the language dictation listens for, if it is not the `id`.
- `font`: the fonts the bar draws the language's text in, a CSS font-family list tried in order before the theme's font. Korean's is `"Noto Sans CJK KR", "Noto Sans CJK JP"`: the Frame's system font has no Hangul.

A language of yours replaces the bundled one with its code: to change the Japanese words, copy it to `~/.config/polykey/packs/ja/language.json` and edit it there.

## A Hangul table

The Korean keyboard's composer (`"composer": "hangul-2set"`, for its 2-set layout) reads the table its `table` names, whose `hangul` says which jamo typed one after the other make one. This is [`packs/ko/hangul.json`](../packs/ko/hangul.json)'s:

```json
"hangul": {
 "compoundMedials": ["ㅗㅏㅘ", "ㅗㅐㅙ", "ㅗㅣㅚ", "ㅜㅓㅝ", "ㅜㅔㅞ", "ㅜㅣㅟ", "ㅡㅣㅢ"],
 "compoundFinals": ["ㄱㅅㄳ", "ㄴㅈㄵ", "ㄴㅎㄶ", "ㄹㄱㄺ", "ㄹㅁㄻ", "ㄹㅂㄼ", "ㄹㅅㄽ", "ㄹㅌㄾ", "ㄹㅍㄿ", "ㄹㅎㅀ", "ㅂㅅㅄ"]
}
```

- `compoundMedials` and `compoundFinals` are the jamo typed one after the other that make one: `"ㄹㄱㄺ"` is ㄹ then ㄱ, making ㄺ. A vowel typed after a compound final takes its second consonant (닭 + ㅏ → 달 가). A pair's jamo are three vowels, or three consonants that can end a syllable.
- The jamo themselves are Unicode's, not the table's: a syllable is `0xAC00 + (initial × 21 + medial) × 28 + final`, each its jamo's place in Unicode's lists (in `src/core/composers/hangul.ts`). ㄸ, ㅃ and ㅉ end no syllable, so they always start a new one.
- Another Hangul layout is its own layout pack, with this table or one of its own.

## Word lists

A keyboard's `lexicon` names the word list its suggestions come from: `en/words` is `packs/en/words.tsv`, with a word, a tab and a count on each line (`#` starts a comment), up to 8 MiB.

- A list in `~/.config/polykey/packs/<namespace>/` replaces the bundled one with the same name.
- Words in `~/.config/polykey/packs/<namespace>/blocked.txt`, one per line, are never suggested from that namespace's lists.

## A picker set

The emoji picker shows one set at a time: emoji ([`packs/emoji/emoji.json`](../packs/emoji/emoji.json)), kaomoji ([`packs/emoji/kaomoji.json`](../packs/emoji/kaomoji.json)) and any of your own. The key next to ABC on its bottom row goes to the next set, in the order above with yours after, and shows what that set's `key` says. With one set there is no such key.

Save this as `~/.config/polykey/packs/mine/symbols.json` and restart polykey for a third set, with two categories:

```json
{
 "schemaVersion": 1,
 "kind": "picker",
 "id": "mine/symbols",
 "name": {"en": "Symbols", "ja": "記号"},
 "key": {"icon": "symbols"},
 "cells": "emoji",
 "recent": true,
 "recentBin": true,
 "categories": [
  {"id": "arrows", "name": "Arrows", "icon": "right", "items": ["→", "←", "↑", "↓", "↔", "⇒", "⇐"]},
  {"id": "maths", "name": {"en": "Maths", "ja": "数学"}, "label": true, "items": ["±", "×", "÷", "≠", "≤", "≥", "∞",
   {"text": "√", "reading": ["るーと"], "tags": ["平方根"]}]}
 ]
}
```

A set has only what its pack says:

- `key` is what the mode key shows when this set is next: `{"icon": "symbols"}`, one of polykey's icons (listed under `iconName` in the schema), or `{"label": ":-)"}`, up to 8 characters.
- `cells` is how an item is drawn: `"emoji"`, or `"text"` for text on a key, shrunk to fit its cell, in fonts that cover many scripts (kaomoji).
- `cellWidth` is how wide a cell is, in emoji cells: 1 when left out, 2.5 for kaomoji, up to 4.
- `"recent": true` puts a Recent section first, with what you last typed from this set. Each set keeps its own.
- `"recentBin": true` puts a bin in Recent's last place, to empty it.
- `"favorites": true` adds Favorites after Recent, filled by drag and drop from it. Every set with Favorites shows the same ones.
- `"tones": true` offers skin tones. A toned emoji is written as six strings, `[base, light, medium-light, medium, medium-dark, dark]`, in place of one.

And so does a category:

- Its tab is its `icon`, or its `name` without one.
- `"label": true` puts a divider before it in the grid with its name beside it. Another name there (`"label": "Steam"`) shows that instead.
- `"apart": true` sets it apart from the category before, with twice the gap.
- An item is a string: what the picker shows and types, up to 64 characters on one line. Or it is an object with that as its `text`, and optional `reading` (words in hiragana that could call the item up) and `tags` (words that describe it): up to 16 of each, 32 characters a word. Nothing uses them yet; they are kept for suggesting items as you type.
- `"items": {"steam": "sticker"}` makes it your Steam stickers (`emoticon` and `effect` are the other kinds), as the emoji set's last three categories are. In a set with one, Recent and Favorites hold Steam items too.

A set has up to 64 categories and 4000 items, a category up to 2000 items. An `id` is lowercase letters, digits and `-`; `recent` and `favorites` are the picker's own. polykey shows up to 16 sets.

### Changing a bundled set

A pack of yours with a bundled set's id is laid over it. Save this as `~/.config/polykey/packs/emoji/kaomoji.json` to replace kaomoji's Love category and add one of your own after the others:

```json
{
 "schemaVersion": 1,
 "kind": "picker",
 "id": "emoji/kaomoji",
 "name": {"en": "Kaomoji", "ja": "顔文字"},
 "key": {"label": ":-)"},
 "cells": "text",
 "categories": [
  {"id": "love", "name": {"en": "Love", "ja": "ハート"}, "label": true, "items": ["(♡˙︶˙♡)", "(´ ▽ `).｡ｏ♡"]},
  {"id": "mine", "name": "Mine", "label": true, "items": ["ʕ•ᴥ•ʔ"]}
 ]
}
```

- A category with a bundled category's id replaces it, in its place. Any other is added after the bundled ones.
- `name`, `key` and `cells` are yours. What your pack leaves out (`cellWidth`, `recent`, `recentBin`, `favorites`, `tones`) stays as bundled, and `"favorites": false` switches one off.
- If your pack has a mistake, the bundled set shows as it was.

### Items in a data file

A list too long for a pack, or one from a source of its own, goes in a data file, and the category points to it:

```json
{"id": "smileys", "name": "Smileys & Emotion", "icon": "smileys", "items": {"file": "emoji/emoji.data"}}
```

- The file is `<namespace>/<name>.data`, JSON, up to 256 KiB: `{"groups": [{"id": "smileys", "items": ["😀", "😃"]}]}`.
- The category takes the group with its own id, or the one `"group"` names.
- A copy in your packs folder is read before the bundled file, group by group.
- `packs/emoji/emoji.data` is every emoji, built from Unicode's `emoji-test.txt` by `scripts/make-emoji.py`. `packs/emoji/kaomoji.data` is the kaomoji from kaomojikan/kaomoji-data, with their readings and tags.

## Adding a pack to polykey

To offer a pack to everyone, put it in `packs/` and open a pull request, as [CONTRIBUTING.md](CONTRIBUTING.md) describes. Each bundled layout has its own checks: `npm run test:layout -- <id>` runs them.
