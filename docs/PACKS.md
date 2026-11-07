# Packs

polykey's layouts, keyboards and themes are JSON files called packs, and you can add your own.

## Where they go

- polykey's own packs are in [`packs/`](../packs/), one folder per namespace: `en`, `ja`, `themes` and so on.
- Yours go on the Frame in `~/.config/polykey/packs/<namespace>/`, in a namespace of your own (`mine` in the examples below).
- Each file holds one item. Its `id` is `<namespace>/<name>`, in lower-case letters, digits and `-`, and starts with its folder's name.
- An item with the same id as a bundled one replaces it. Any other id adds a new one.
- New keyboards show up in Settings → Keyboards, under their language. New themes show up in the theme picker.

polykey reads packs each time it starts in Steam. After you change one, restart it:

```sh
systemctl --user restart polykey
```

A file with a mistake is skipped, never fatal. Its error shows at the foot of the Settings tab and in the journal (`journalctl --user -u polykey`). polykey reads up to 256 of your pack files, of up to 256 KiB each.

## Kinds

Every item has `schemaVersion` (1), `kind`, `id` and `name`. [`packs/pack.schema.json`](../packs/pack.schema.json) describes every field.

- **theme:** the colours. `surface`, `key`, `keyText`, `modifier` and `accent` are required, and the other colours fall back to them. Add `"tone": "light"` for a light theme.
- **layout:** the keys, row by row, and the toolbar above them. A layout can `extends` another and replace only some of its rows.
- **keyboard:** a layout and what typing on it does: its language, its word list for suggestions, the options it offers in settings, and, for Japanese, how it composes and converts. A keyboard can `extends` another too.
- **table:** a romaji table (ka → か), or the cycles of the ゛゜小 key.

The bundled packs are the best examples: [`packs/themes/`](../packs/themes/), [`packs/en/`](../packs/en/) and [`packs/ja/`](../packs/ja/).

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

## Word lists

A keyboard's `lexicon` names the word list its suggestions come from: `en/words` is `packs/en/words.tsv`, with a word, a tab and a count on each line (`#` starts a comment), up to 8 MiB.

- A list in `~/.config/polykey/packs/<namespace>/` replaces the bundled one with the same name.
- Words in `~/.config/polykey/packs/<namespace>/blocked.txt`, one per line, are never suggested from that namespace's lists.

## Emoji

The emoji picker's data is `packs/emoji/emoji.data`, built from Unicode's `emoji-test.txt` by `scripts/make-emoji.py`. A valid copy in `~/.config/polykey/packs/emoji/emoji.data` is used instead.

## Adding a pack to polykey

To offer a pack to everyone, put it in `packs/` and open a pull request, as [CONTRIBUTING.md](CONTRIBUTING.md) describes. Each bundled layout has its own checks: `npm run test:layout -- <id>` runs them.
