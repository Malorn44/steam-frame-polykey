// polykey in Steam's keyboard popup: renders the selected keyboard over the stock keys and sends what
// is typed through Steam. Fails safe: does nothing while required Steam objects are missing or fjk is
// active; never logs typed text; never leaves a key held. Idempotent: a re-injection replaces it.

import { createBridge } from './bridge/client.js';
import { readBoot, type ActionName, type Boot, type KeyboardDef, type KeyboardOptions, type KeyDef, type Theme } from './core/catalog.js';
import { CLIPBOARD_CHORDS } from './core/keycodes.js';
import { NO_MODS, charText, flickText, kanaSide, press, pressText, type Effect, type Mods } from './core/keyboard.js';
import { chooseDelivery } from './core/output/plan.js';
import { NO_WORD, matchCase, rank, replaceWord, slotOrder, suggestPrefix, trackWord, type WordState } from './core/suggest.js';
import { getKeyboardPopupWindow, pickKeyboardManager, type SteamGlobals } from './host/steam/globals.js';
import { classifyTarget, describeStatus, findStatusStore, keyboardMode, readStatus, type StatusStore } from './host/steam/diag.js';
import { createKeySender, getSetKeyState } from './host/steam/keys.js';
import { fjkActive, otherKeyboards } from './host/steam/others.js';
import { createOutput } from './host/steam/output.js';
import { mountSurface, overlayRect, type Surface } from './host/steam/popup.js';
import { missingPrerequisites } from './host/steam/probe.js';
import { createStockGuard } from './host/steam/stock-guard.js';
import { HAPTIC, haptic, onCursor, steamKeyboardStyle } from './host/steam/vr.js';
import { log, warn } from './log.js';
import { NO_EMOJI_STATE, steamItemEffects, steamKey, toneTable, useRecent, withTone, type EmojiState, type Tone } from './core/emoji.js';
import { steamItemImage, steamItems, steamItemsAvailable } from './host/steam/items.js';
import { RECENT_MAX, createEmojiView, type EmojiView } from './ui/emoji.js';
import { modifyTable } from './core/kana.js';
import { modeLetters, pageLayout } from './core/pages.js';
import { romajiTable, type RomajiTable } from './core/romaji.js';
import { NO_ENGLISH, commitEnglish, englishText, pressEnglish, type EnglishWord } from './core/english.js';
import { FORM_LABELS, inForm, nextForm } from './core/forms.js';
import { NO_IME, composing, flush, settleRomaji, liveCandidates, pickCandidate, pressIme, reading, withConversion, type Ime, type ImeRequest, type ImeResult, type Segment } from './core/ime.js';
import { OPTIONS, offered, optionsFor, type OptionName } from './core/options.js';
import { fullName, languageName } from './ui/keyboards-page.js';
import { createSettingsView, type SettingsTab, type SettingsValues, type SettingsView } from './ui/settings.js';
import { createView, type View } from './ui/view.js';
import { ICONS } from './ui/icons.js';
import { themeVars } from './ui/theme.js';

declare const __POLYKEY_VERSION__: string;
export const VERSION: string = typeof __POLYKEY_VERSION__ === 'string' ? __POLYKEY_VERSION__ : 'dev';

export const GLOBAL = '__polykey';
export const BOOT_GLOBAL = '__polykeyBoot';
/** Popup and open-state check; also picks up a recreated popup. */
export const CHECK_MS = 5000;
export const PREREQ_RETRY_MS = 1000;
export const PREREQ_TIMEOUT_MS = 120_000;
/** Gap between key-state events (TaiKeid: IBus reorders keys sent with no gap). */
export const KEY_GAP_MS = 8;
/** Steam's own keyboard (settings → Steam keyboard; 🌐 only rotates polykey's keyboards). */
export const STOCK = 'steam/stock';
const NON_ASCII = /[^\x20-\x7e]/;
/** The emoji picker's bottom row (a layout pack). */
const EMOJI_ROW = 'internal/emoji-row';
const EMOJI_ROW_PX = 44;
const EMOJI_SAVE_DELAY_MS = 1500;

export type State = 'waiting' | 'blocked' | 'running' | 'inactive' | 'uninstalled';

export interface PolykeyApi {
  readonly version: string;
  state: State;
  uninstall(): void;
  bridgeReply(reply: unknown): void;
  readonly debug: {
    status(): string;
    /** Switch keyboard by id (or 'steam/stock'). */
    use(id: string): string;
  };
}

const errorKind = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

export const installPolykey = (g: SteamGlobals = globalThis as unknown as SteamGlobals): PolykeyApi => {
  const previous = g[GLOBAL] as Partial<PolykeyApi> | undefined;
  if (typeof previous?.uninstall === 'function') {
    try {
      previous.uninstall();
    } catch (error) {
      warn('previous instance failed to uninstall:', errorKind(error));
    }
  }

  const boot: Boot | null = readBoot(g[BOOT_GLOBAL]);
  // The keyboards 🌐 goes through, in order (settings → Keyboards changes them).
  let ring = (boot?.settings.keyboards ?? []).filter((id) => boot?.catalog.keyboards[id]);
  let current = 0;
  /** Showing Steam's own keyboard, with a button back to polykey. */
  let stock = false;
  // Each keyboard's options as the user set them.
  const keyboardOptions: Record<string, KeyboardOptions> = { ...(boot?.settings.keyboardOptions ?? {}) };
  const modifyTables = new Map<string, ReadonlyMap<string, string>>();
  // The reading buffer of a keyboard with composer "kana" (core/ime.ts): typed kana wait here, shown in
  // the bar, until confirmed. `live` are the candidates while typing; a generation drops stale replies.
  let ime: Ime = NO_IME;
  let live: string[] = [];
  // Where the live candidates came from, so a picked one can be learned.
  let liveSource: { reading: string; segments: Omit<Segment, 'index'>[]; predictions: string[] } | null = null;
  let imeGeneration = 0;
  // Keyboards in 英数 mode (a JIS keyboard's keys type their Latin legends); the rest are in かな mode.
  const latinMode = new Set<string>();
  // Keyboards showing a numbers and symbols page (the 12-key's ?123 is 1, its =\< page 2).
  const symbolsOn = new Map<string, 1 | 2>();
  let converterDown = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let surface: Surface | null = null;
  let view: View | null = null;
  let panel: SettingsView | null = null;
  let picker: EmojiView | null = null;
  let page: 'keys' | 'settings' | 'emoji' = 'keys';
  // The settings page's tab, and the language whose layouts Keyboards shows (default: the current one's).
  let settingsTab: SettingsTab = 'general';
  let settingsLanguage: string | undefined;
  // Emoji: Recent, Favorites and the skin tone, saved by the sidecar (~/.config/polykey/emoji.json).
  let emoji: EmojiState = boot?.emojiState ?? NO_EMOJI_STATE;
  const tones = toneTable(boot?.emoji ?? { groups: [] });
  let emojiSave: ReturnType<typeof setTimeout> | null = null;
  let guard: ReturnType<typeof createStockGuard> | null = null;
  let returnButton: HTMLElement | null = null;
  let stopCursor: (() => void) | null = null;
  let hand = 0;
  let statusStore: StatusStore | null = null;
  let mods: Mods = NO_MODS;
  let wasOpen = false;
  let waitingSince = 0;
  let queue: Promise<unknown> = Promise.resolve();
  // Suggestions: the word being typed, words used this session (memory only), and a generation so a
  // slow reply never shows suggestions for an older word.
  let word: WordState = NO_WORD;
  const session = new Map<string, number>();
  let suggestGeneration = 0;
  // Settings the page can change (the sidecar saves them); haptics and suggestions default on.
  const settings: SettingsValues = {
    theme: boot?.settings.theme ?? '',
    haptics: boot?.settings.haptics !== false,
    suggestions: boot?.settings.suggestions !== false,
  };
  const tick = (win: Window, which: number): void => { if (settings.haptics) haptic(win, HAPTIC.enter, which); };

  const output = createOutput({
    getManager: () => pickKeyboardManager(g),
    getDelivery: () => chooseDelivery(keyboardMode(readStatus(statusStore)), 'auto'),
  });
  const keys = createKeySender({ getSetKeyState: () => getSetKeyState(g) });
  const bridge = createBridge(g);

  const stopTimer = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const startTimer = (fn: () => void, ms: number): void => {
    stopTimer();
    timer = setInterval(fn, ms);
  };

  /** Non-ASCII into KDE Desktop Mode goes by paste; the sidecar refuses unless the desktop has focus. */
  const sendText = async (text: string): Promise<void> => {
    if (NON_ASCII.test(text) && classifyTarget(readStatus(statusStore)) === 'local-app' && bridge.available()) {
      const prepared = await bridge.call('desktop.prepare', { text });
      if (prepared.ok) {
        const pressed = await keys.send(CLIPBOARD_CHORDS.paste, KEY_GAP_MS);
        await bridge.call('desktop.wait', { timeoutMs: pressed.ok ? 2000 : 0 }, 4000);
        return;
      }
    }
    const result = await output([{ text }]);
    if (!result.ok) warn(`text not sent: ${result.error ?? '?'}`);
  };

  const runAction = (action: ActionName): void => {
    if (action === 'hide') void output([{ key: 'VKClose' }]);
    else if (action === 'next-keyboard') switchTo((current + 1) % Math.max(1, ring.length));
    else if (action === 'settings' || action === 'emoji' || action === 'abc') {
      if (page === 'emoji') saveEmoji(0);
      page = action === 'abc' ? 'keys' : action === 'emoji' && boot?.emoji ? 'emoji' : action === 'emoji' ? 'keys' : 'settings';
      if (action === 'emoji' && !boot?.emoji) log('emoji: no emoji data from the sidecar');
      render();
    }
    else log(`${action}: not available yet`);
  };

  const apply = async (effect: Effect): Promise<void> => {
    if (effect.kind === 'text') await sendText(effect.text);
    else if (effect.kind === 'key') await output([{ key: effect.key }]);
    else if (effect.kind === 'chord') {
      const result = await keys.send(effect.events, KEY_GAP_MS);
      if (!result.ok) warn(`key chord not sent: ${result.error ?? '?'}`);
    } else runAction(effect.action);
  };

  const enqueue = (effects: readonly Effect[]): void => {
    // In order, one press after another, so fast typing never interleaves.
    queue = queue.then(async () => {
      for (const effect of effects) await apply(effect);
    }).catch((error) => warn('key failed:', errorKind(error)));
  };

  const boost = (used: string): void => { session.set(used.toLowerCase(), (session.get(used.toLowerCase()) ?? 0) + 1); };

  /** A keyboard with a reading buffer (the Japanese ones). */
  const buffered = (keyboard: KeyboardDef | undefined): boolean => keyboard?.composer === 'kana' || keyboard?.composer === 'romaji';
  /** Word suggestions: a Japanese keyboard has them only in 英数 mode, in its candidate area. */
  const lexiconId = (): string | undefined => {
    const keyboard = boot?.catalog.keyboards[ring[current] as string];
    return buffered(keyboard) && !latinMode.has(keyboard!.id) ? undefined : keyboard?.lexicon;
  };
  /** The words suggested on a Japanese keyboard in 英数 mode, best first (shown as candidates). */
  let suggested: string[] = [];
  /** The English word typed in a Japanese keyboard's 英数 mode, in the bar until sent (core/english.ts). */
  let en: EnglishWord = NO_ENGLISH;
  /** Send the English word (a keyboard switch, another key); it counts as used for ranking. */
  const sendEnglish = (): void => {
    if (!en.chars.length) return;
    boost(englishText(en));
    enqueue(commitEnglish(en));
    en = NO_ENGLISH;
    refreshSuggestions();
  };
  const showWords = (words: string[]): void => {
    if (buffered(boot?.catalog.keyboards[ring[current] as string])) {
      suggested = words;
      showIme();
    } else view?.setSuggestions(slotOrder(words));
  };

  const refreshSuggestions = (): void => {
    const generation = ++suggestGeneration;
    const inBar = buffered(boot?.catalog.keyboards[ring[current] as string]);
    const prefix = inBar ? englishText(en) || null : suggestPrefix(word);
    const lexicon = lexiconId();
    if (!prefix || !lexicon || !settings.suggestions || !bridge.available()) {
      showWords([]);
      return;
    }
    void bridge.call('suggest', { prefix, lexicon, limit: 8 }).then((reply) => {
      if (generation !== suggestGeneration) return;
      const words = reply.ok && Array.isArray(reply['words']) ? (reply['words'] as string[]) : [];
      showWords(rank(words, session, inBar ? 8 : 3).map((w) => matchCase(w, prefix)));
    });
  };

  const setWord = (next: WordState): void => {
    word = next;
    refreshSuggestions();
  };

  const currentKeyboard = () => boot?.catalog.keyboards[ring[current] ?? ''];
  const romajiTables = new Map<string, RomajiTable>();
  /** Whether a keyboard types romaji: the romaji keyboard, or a JIS kana keyboard with its romajiInput option on. */
  const typesRomaji = (keyboard: KeyboardDef | undefined): boolean => keyboard?.composer === 'romaji'
    || (keyboard?.composer === 'kana' && optionsFor(keyboard, keyboardOptions[keyboard.id]).romajiInput);
  /** The keyboard's romaji table while it types romaji. */
  const romajiFor = (keyboard: KeyboardDef | undefined): RomajiTable | undefined => {
    const tableId = keyboard?.table;
    const def = tableId ? boot?.catalog.tables?.[tableId] : undefined;
    if (!tableId || !def?.entries || !typesRomaji(keyboard)) return undefined;
    let table = romajiTables.get(tableId);
    if (!table) romajiTables.set(tableId, (table = romajiTable(def.entries)));
    return table;
  };
  const modifyFor = (layoutId: string): ReadonlyMap<string, string> => {
    let table = modifyTables.get(layoutId);
    if (!table) modifyTables.set(layoutId, (table = modifyTable(boot?.catalog.layouts[layoutId]?.modify)));
    return table;
  };

  /** Fn is on and the key has an Fn variant (JIS: Fn+1 is F1): it goes out as that key, not into a buffer. */
  const fnKey = (key: KeyDef): boolean => mods.fn !== 'off' && (key.type === 'char' || key.type === 'key') && !!key.fn;

  const onKey = (key: KeyDef, alternate?: string, repeat = false): void => {
    if (surface && !repeat) tick(surface.win, hand); // one tick per press, not per repeat
    if (key.type === 'action' && key.action === 'next-keyboard' && alternate !== undefined) {
      const index = ring.indexOf(alternate); // picked from the menu held on 🌐
      if (index >= 0 && index !== current) switchTo(index);
      return;
    }
    const keyboard = currentKeyboard();
    const options = optionsFor(keyboard, keyboard ? keyboardOptions[keyboard.id] : undefined);
    const latin = keyboard ? latinMode.has(keyboard.id) : false;
    // 英数 and かな (the Mac's two keys): one-way switches between typing Latin and typing kana.
    if (keyboard && key.type === 'action' && (key.action === 'eisu' || (key.action === 'kana' && latin))) {
      if (key.action === 'eisu' && !latin) {
        if (composing(ime)) applyIme(flush(ime, romajiFor(keyboard))); // 英数 sends the reading first
        latinMode.add(keyboard.id);
      } else if (key.action === 'kana') {
        sendEnglish(); // かな sends the English word first
        latinMode.delete(keyboard.id);
      }
      setWord(NO_WORD); // suggestions only for words typed in 英数 mode
      if (keyboard.pages?.latin) render(); // the 12-key: ABC keys in 英数 mode
      else {
        view?.setMode(latinMode.has(keyboard.id));
        view?.update(mods);
      }
      return;
    }
    // ?123: the numbers and symbols page, and back; what is being typed stays (3 + じ → 3時).
    if (keyboard?.pages?.symbols && key.type === 'action' && (key.action === 'symbols' || key.action === 'more-symbols')) {
      const shown = symbolsOn.get(keyboard.id);
      if (key.action === 'more-symbols') symbolsOn.set(keyboard.id, shown === 2 ? 1 : 2); // =\< and back to 123
      else if (shown) symbolsOn.delete(keyboard.id); // back to the letters
      else symbolsOn.set(keyboard.id, 1);
      render();
      return;
    }
    // 英数 mode on a Japanese keyboard: English words wait in the bar with their suggestions.
    if (keyboard && buffered(keyboard) && page === 'keys' && latin) {
      const chording = mods.ctrl !== 'off' || mods.alt !== 'off' || mods.super !== 'off' || fnKey(key);
      const typed = chording ? undefined
        : key.type === 'char' ? (alternate ?? charText(key, mods))
          : key.type === 'flick' ? flickText(alternate ?? key.flick[0], mods) : undefined;
      const handled = pressEnglish(en, key, typed, { tapCycle: options.tapCycle, flicked: alternate !== undefined });
      if (handled) {
        if (typed !== undefined) {
          mods = pressText(mods, '').mods; // a one-shot Shift is used up
          view?.update(mods);
        }
        if (en.chars.length && !handled.word.chars.length && handled.effects.length) boost(englishText(en));
        en = handled.word;
        enqueue(handled.effects);
        refreshSuggestions();
        showIme();
        return;
      }
      if (key.type !== 'mod') sendEnglish(); // any other key sends the word first
    }
    if (keyboard && buffered(keyboard) && page === 'keys' && !latin) {
      const romaji = romajiFor(keyboard);
      // A typed key goes into the buffer with Shift applied; with Ctrl, Alt or Super it is a shortcut.
      const chording = mods.ctrl !== 'off' || mods.alt !== 'off' || mods.super !== 'off' || fnKey(key);
      const side = kanaSide(key, !romaji); // a JIS key types its kana (its Latin legend with romaji input)
      const typed = side.type === 'char' && !chording ? (alternate ?? charText(side, mods)) : undefined;
      const handled = pressIme(ime, key, { ...(key.type === 'flick' && alternate !== undefined ? { flicked: alternate } : {}), ...(typed !== undefined ? { typed } : {}) },
        options, { modify: modifyFor(keyboard.layout), ...(romaji ? { romaji } : {}) });
      if (handled) {
        if (typed !== undefined) {
          mods = pressText(mods, '').mods; // a one-shot Shift is used up
          view?.update(mods);
        }
        applyIme(handled);
        return;
      }
      // Any other key sends the buffer first (a modifier only arms, so it does not).
      if (composing(ime) && key.type !== 'mod') applyIme(flush(ime, romaji));
    }
    const result = alternate === undefined ? press(mods, key)
      : pressText(mods, key.type === 'flick' ? flickText(alternate, mods) : alternate); // a flicked letter takes Shift
    mods = result.mods;
    view?.update(mods);
    const tracked = trackWord(word, result.effects);
    if (tracked.ended) boost(tracked.ended);
    setWord(tracked.state);
    enqueue(result.effects);
  };

  const segmentsOf = (reply: Record<string, unknown>): Omit<Segment, 'index'>[] =>
    (reply['ok'] && Array.isArray(reply['segments']) ? reply['segments'] as Omit<Segment, 'index'>[] : []);
  const noteConverter = (reply: Record<string, unknown>): void => {
    if (reply['error'] === 'unavailable' && !converterDown) {
      converterDown = true;
      warn('conversion unavailable (libanthy did not load); 確定 still sends the kana');
    }
  };

  /** Ask the converter for live candidates or a conversion of the buffer; stale replies are dropped. */
  const requestIme = (request: ImeRequest): void => {
    const generation = ++imeGeneration;
    // Live candidates see pending letters settled (かn → かん); a conversion's buffer is settled already.
    const forReading = reading(settleRomaji(ime, romajiFor(currentKeyboard())));
    if (!forReading || !bridge.available()) {
      live = forReading ? liveCandidates(forReading, [], []) : [];
      showIme();
      return;
    }
    if (request.kind === 'live') {
      live = liveCandidates(forReading, [], []); // the kana themselves until the converter answers
      void Promise.all([
        bridge.call('convert', { reading: forReading }),
        bridge.call('predict', { reading: forReading }),
      ]).then(([converted, predicted]) => {
        noteConverter(converted);
        if (generation !== imeGeneration) return;
        const predictions = predicted.ok && Array.isArray(predicted['predictions']) ? predicted['predictions'] as string[] : [];
        live = liveCandidates(forReading, segmentsOf(converted), predictions);
        liveSource = { reading: forReading, segments: segmentsOf(converted), predictions };
        showIme();
      });
    } else {
      void bridge.call('convert', {
        reading: forReading,
        ...(request.lengths ? { lengths: request.lengths } : {}),
        ...(request.resize ? { resize: request.resize } : {}),
      }).then((reply) => {
        noteConverter(reply);
        if (generation !== imeGeneration) return;
        ime = withConversion(ime, forReading, segmentsOf(reply));
        showIme();
      });
    }
    showIme();
  };

  /** Draw the buffer in the bar (or the word suggestions when it is empty); 空白 becomes 変換 (次変換 once converting), ⏎ 確定. */
  const showIme = (): void => {
    if (!view) return;
    if (!composing(ime)) {
      // 英数 mode: English word suggestions where the candidates go; picking one replaces the word typed.
      view.setComposition(en.chars.length ? {
        before: en.chars.slice(0, en.caret).join(''), after: en.chars.slice(en.caret).join(''), candidates: suggested, selected: -1,
      } : null);
      view.setLabels(en.chars.length ? { Enter: '確定' } : {});
    } else {
      const focused = ime.segments?.[ime.focus];
      view.setComposition(ime.segments
        ? { segments: ime.segments.map((s) => s.candidates[s.index] ?? s.reading), focus: ime.focus,
          candidates: focused?.candidates ?? [], selected: focused?.index ?? -1 }
        : { before: inForm(ime.chars.slice(0, ime.caret).join(''), ime.form), after: inForm(ime.chars.slice(ime.caret).join(''), ime.form),
          candidates: live, selected: -1 });
      // Once converting, Space goes to the next candidate; かな shows the form it changes the reading to.
      view.setLabels({ ' ': ime.segments ? '次変換' : '変換', Enter: '確定', kana: ime.segments ? FORM_LABELS.katakana : FORM_LABELS[nextForm(ime.form)] });
    }
    view.update(mods);
  };

  /** Have the converter learn what was sent (anthy's learning data, ~/.anthy). */
  const learn = (request: Record<string, unknown>): void => {
    if (bridge.available()) void bridge.call('learn', request);
  };

  const applyIme = (result: ImeResult): void => {
    if (result.learned) learn({ ...result.learned });
    ime = result.ime;
    if (result.effects.length) enqueue(result.effects);
    if (result.request) requestIme(result.request);
    else showIme();
  };

  const onCandidate = (text: string, index: number): void => {
    if (!composing(ime) && en.chars.length) {
      // A suggestion for the English word: sent in its place, with a space.
      if (surface) tick(surface.win, hand);
      boost(text);
      enqueue([{ kind: 'text', text: `${text} ` }]);
      en = NO_ENGLISH;
      refreshSuggestions();
      return;
    }
    if (surface) tick(surface.win, hand);
    const source = !ime.segments && liveSource?.reading === reading(ime) ? liveSource : null;
    if (source && source.segments.length && text === source.segments.map((s) => s.candidates[0] ?? s.reading).join('')) {
      learn({ reading: source.reading, lengths: source.segments.map((s) => Array.from(s.reading).length),
        choices: source.segments.map(() => 0), texts: source.segments.map((s) => s.candidates[0] ?? s.reading) });
    } else if (source?.predictions.includes(text)) learn({ reading: source.reading, prediction: text });
    applyIme(pickCandidate(ime, text, index));
  };

  const onSuggestion = (chosen: string): void => {
    if (surface) tick(surface.win, hand);
    const typed = word.word;
    boost(chosen);
    setWord(NO_WORD);
    enqueue(replaceWord(typed, chosen));
  };

  const unmountView = (): void => {
    stopCursor?.();
    stopCursor = null;
    view?.destroy();
    view = null;
    panel?.destroy();
    panel = null;
    picker?.destroy();
    picker = null;
    returnButton?.remove();
    returnButton = null;
  };

  /** Size the current page's parts to the keyboard area: the emoji page is the picker above its key row. */
  const applyBounds = (): void => {
    if (!surface) return;
    const rect = overlayRect(surface.win);
    if (picker) {
      picker.setBounds({ ...rect, height: rect.height - EMOJI_ROW_PX });
      view?.setBounds({ ...rect, top: rect.top + rect.height - EMOJI_ROW_PX, height: EMOJI_ROW_PX });
    } else {
      view?.setBounds(rect);
      panel?.setBounds(rect);
    }
  };

  /** Show the current keyboard, or Steam's own with a way back. */
  const render = (): void => {
    if (!surface || !boot) return;
    unmountView();
    const id = ring[current] ?? '';
    if (stock) {
      guard?.setActive(false);
      // Back to polykey: the 文A icon in the current theme's colours, radius and shadow.
      const button = surface.doc.createElement('div');
      button.innerHTML = ICONS.translate;
      button.setAttribute('role', 'button');
      button.setAttribute('aria-label', 'Back to polykey');
      const theme = themeFor(surface.win);
      button.style.cssText = `${theme ? themeVars(theme) : ''}position:fixed;top:4px;right:4px;padding:7px;display:flex;font-size:22px;`
        + 'border-radius:var(--radius, 6px);background:var(--surface, #23262e);color:var(--text, #fff);box-shadow:var(--shadow);pointer-events:auto;';
      const back = (e: Event): void => {
        e.preventDefault();
        e.stopPropagation();
        stock = false;
        switchTo(current);
      };
      button.addEventListener('touchend', back);
      button.addEventListener('click', back);
      surface.shadow.append(button);
      returnButton = button;
      return;
    }
    const keyboard = boot.catalog.keyboards[id];
    const layout = keyboard && boot.catalog.layouts[pageLayout(keyboard, {
      latin: latinMode.has(keyboard.id), symbols: symbolsOn.get(keyboard.id) ?? 0, qwerty: optionsFor(keyboard, keyboardOptions[id]).qwertyLatin,
    })];
    const theme = themeFor(surface.win);
    if (!layout || !theme) {
      warn(`keyboard ${id} has no layout or theme; showing Steam's keyboard`);
      return;
    }
    guard?.setActive(true);
    const win = surface.win;
    if (page === 'emoji' && boot.emoji) {
      picker = createEmojiView(surface.doc, surface.shadow, theme, {
        data: boot.emoji,
        steam: steamItems(g).map((item) => ({ item, image: steamItemImage(g, item) })),
        steamAvailable: steamItemsAvailable(g),
        tones,
      }, emoji, { onEmoji: typeEmoji, onTone, onSteam, onFavorites, onClearRecent });
      const row = boot.catalog.layouts[EMOJI_ROW];
      if (row) {
        // Its back key reads the current mode's letters (あいう, ABC).
        view = createView(surface.doc, surface.shadow, row, theme, onKey, onSuggestion, undefined,
          { letters: modeLetters(keyboard, latinMode.has(id)) });
        view.update(mods);
      }
      applyBounds();
    } else if (page === 'settings') {
      panel = createSettingsView(surface.doc, surface.shadow, theme, settings, {
        themes: Object.values(boot.catalog.themes).map((t) => ({ id: t.id, name: t.name })),
        version: VERSION,
        errors: boot.errors,
        suggestions: !!keyboard?.lexicon,
        keyboardName: keyboard ? fullName(keyboard) : id,
        options: offered(keyboard).map((name) => ({ id: name, ...OPTIONS[name], value: optionsFor(keyboard, keyboardOptions[id])[name] })),
        tab: settingsTab,
        keyboards: {
          all: Object.values(boot.catalog.keyboards).map((k) => ({ id: k.id, name: k.name, language: k.language ?? 'und' })),
          ring,
          language: settingsLanguage ?? keyboard?.language ?? 'en',
        },
      }, {
        onTab: (tab) => { settingsTab = tab; render(); },
        onLanguage: (code) => { settingsLanguage = code; render(); },
        onKeyboards: changeKeyboards,
        onChange: changeSettings,
        onOption: (name, value) => changeOption(id, name as OptionName, value),
        onStock: () => { page = 'keys'; stock = true; switchTo(current); },
        onClose: () => { page = 'keys'; render(); },
      });
      applyBounds();
    } else {
      view = createView(surface.doc, surface.shadow, layout, theme, onKey, onSuggestion, onCandidate,
        { side: optionsFor(keyboard, keyboardOptions[id]).candidatesLeft, hints: optionsFor(keyboard, keyboardOptions[id]).flickHints,
          latin: latinMode.has(id), romaji: typesRomaji(keyboard), symbols: symbolsOn.get(id) ?? 0, letters: modeLetters(keyboard, latinMode.has(id)),
          // Holding 🌐: each keyboard's language small above its layout.
          keyboardMenu: { ids: ring, names: ring.map((k) => {
            const def = boot.catalog.keyboards[k];
            return def ? `${def.language ? `${languageName(def.language)}\n` : ''}${def.name}` : k;
          }) },
          ...(keyboard?.strings?.idleHint ? { placeholder: keyboard.strings.idleHint } : {}) });
      view.update(mods);
      applyBounds();
      refreshSuggestions();
      showIme();
    }
    stopCursor = onCursor(win, (x, y, which) => {
      hand = which;
      // A tick as the laser crosses keys, and as a held key's or emoji's pick moves between choices.
      const tones = picker?.hoverAt(x, y) ?? false;
      if ((view ?? panel)?.hoverAt(x, y) || tones) tick(win, which);
    });
  };

  /** Save emoji state after a quiet moment (or now, on leaving the picker). It is typed content: never logged. */
  const saveEmoji = (delay = EMOJI_SAVE_DELAY_MS): void => {
    if (emojiSave !== null) clearTimeout(emojiSave);
    emojiSave = setTimeout(() => {
      emojiSave = null;
      void bridge.call('emoji.save', { state: emoji }).then((reply) => {
        if (!reply.ok) warn(`emoji not saved: ${reply.error ?? '?'}`);
      });
    }, delay);
  };

  const sendEffects = (effects: Effect[]): void => {
    const tracked = trackWord(word, effects);
    setWord(tracked.state);
    enqueue(effects);
  };

  const typeEmoji = (base: string, fromRecent: boolean): void => {
    if (surface) tick(surface.win, hand);
    sendEffects([{ kind: 'text', text: withTone(base, emoji.tone, tones) }]);
    emoji = { ...emoji, recent: useRecent(emoji.recent, base, fromRecent, RECENT_MAX) };
    picker?.update(emoji);
    saveEmoji();
  };

  const onSteam = (item: Parameters<typeof steamItemEffects>[0], fromRecent: boolean): void => {
    if (surface) tick(surface.win, hand);
    sendEffects(steamItemEffects(item));
    emoji = { ...emoji, recent: useRecent(emoji.recent, steamKey(item), fromRecent, RECENT_MAX) };
    picker?.update(emoji);
    saveEmoji();
  };

  /** A skin tone picked from a hold: it applies everywhere from now on, starting with this emoji. */
  const onTone = (tone: Tone, base: string): void => {
    emoji = { ...emoji, tone };
    typeEmoji(base, false);
  };

  const onClearRecent = (): void => {
    if (surface) tick(surface.win, hand);
    emoji = { ...emoji, recent: [] };
    picker?.update(emoji);
    saveEmoji(0);
  };

  const onFavorites = (favorites: string[]): void => {
    emoji = { ...emoji, favorites };
    picker?.update(emoji);
    saveEmoji(0);
  };

  /** A keyboard's own option: applies at once; the sidecar saves every keyboard's choices. */
  /** Your keyboards, from settings → Keyboards: 🌐 follows the new order at once, and the sidecar saves it. */
  const changeKeyboards = (ids: string[]): void => {
    const next = ids.filter((k) => boot?.catalog.keyboards[k]);
    if (!next.length) return;
    const showing = ring[current];
    ring = next;
    void bridge.call('settings.save', { settings: { keyboards: ring } }).then((reply) => {
      if (!reply.ok) warn(`settings not saved: ${reply.error ?? '?'}`);
    });
    if (surface) tick(surface.win, hand);
    const index = ring.indexOf(showing ?? '');
    if (index < 0) switchTo(0); // the one showing was removed
    else {
      current = index;
      render();
    }
  };

  const changeOption = (keyboardId: string, name: OptionName, value: boolean): void => {
    keyboardOptions[keyboardId] = { ...keyboardOptions[keyboardId], [name]: value };
    ime = { ...ime, cycle: null };
    void bridge.call('settings.save', { settings: { keyboardOptions } }).then((reply) => {
      if (!reply.ok) warn(`settings not saved: ${reply.error ?? '?'}`);
    });
    if (surface) tick(surface.win, hand);
    render();
  };

  /** Apply settings at once and have the sidecar save them (a failed save is logged, not fatal). */
  const changeSettings = (changes: Partial<SettingsValues>): void => {
    Object.assign(settings, changes);
    void bridge.call('settings.save', { settings: changes }).then((reply) => {
      if (!reply.ok) warn(`settings not saved: ${reply.error ?? '?'}`);
    });
    if (surface) tick(surface.win, hand);
    render();
  };

  /** The selected theme; a followSteam theme takes Steam's own keyboard colours where it can read them. */
  const themeFor = (win: Window): Theme | undefined => {
    const theme = boot?.catalog.themes[settings.theme] ?? Object.values(boot?.catalog.themes ?? {})[0];
    if (!theme?.followSteam) return theme;
    const steam = steamKeyboardStyle(win);
    return { ...theme, ...(steam.font ? { font: steam.font } : {}), colors: { ...theme.colors, ...steam.colors } };
  };

  const switchTo = (index: number): void => {
    if (composing(ime)) enqueue(flush(ime, romajiFor(currentKeyboard())).effects); // switching keyboards sends the buffer
    if (en.chars.length) enqueue(commitEnglish(en));
    en = NO_ENGLISH;
    symbolsOn.clear(); // a keyboard comes back on its letters
    ime = NO_IME;
    live = [];
    keys.releaseAll();
    mods = NO_MODS;
    current = index;
    render();
    log(`keyboard: ${stock ? STOCK : ring[current]}`);
  };

  const unmount = (): void => {
    unmountView();
    guard?.setActive(false);
    guard = null;
    surface?.destroy();
    surface = null;
  };

  const mount = (win: Window): void => {
    surface = mountSurface(win);
    guard = createStockGuard(win);
    render();
    log(`mounted in keyboard popup (${win.innerWidth}x${win.innerHeight}), keyboard ${ring[current]}`);
  };

  const onOpenChange = (): void => {
    const status = readStatus(statusStore);
    const open = status?.bIsOpen === true;
    if (open !== wasOpen) {
      setWord(NO_WORD); // a new field: we only ever replace letters we typed after this
      if (!open) {
        ime = NO_IME; // the field is gone: an unsent reading is dropped, not typed elsewhere
        live = [];
        showIme();
        keys.releaseAll(); // closing must never leave a key held
        mods = { ...NO_MODS, caps: mods.caps };
        view?.update(mods);
      }
      log(`keyboard ${open ? 'opened' : 'closed'}: ${describeStatus(status)}`);
    }
    wasOpen = open;
  };

  /** Keep the keyboard in the current popup; runs every CHECK_MS. */
  const check = (): void => {
    try {
      if (fjkActive(g)) {
        if (surface) unmount();
        if (api.state !== 'blocked') {
          api.state = 'blocked';
          log('frame-jp-keyboard is active, so polykey is not drawn; stop it to use polykey');
        }
        return;
      }
      if (api.state === 'blocked') api.state = 'running';
      const win = getKeyboardPopupWindow(g);
      // Compare documents, not windows: the document is what changes when Steam recreates the popup.
      if (surface && (surface.doc !== win?.document || !surface.isLive())) {
        unmount();
        log('keyboard popup changed; removed');
      }
      if (!surface && win?.document?.body) mount(win);
      applyBounds();
      onOpenChange();
    } catch (error) {
      warn('check failed:', errorKind(error));
    }
  };

  const tryRun = (): boolean => {
    if (missingPrerequisites(g).length > 0) return false;
    statusStore = findStatusStore(g);
    if (!statusStore) log('VR keyboard status not found; one character per call');
    api.state = 'running';
    startTimer(check, CHECK_MS);
    check();
    log(`running ${VERSION}`);
    return true;
  };

  const start = (): void => {
    if (!boot) {
      api.state = 'inactive';
      warn('no packs from the sidecar; leaving the stock keyboard alone');
      return;
    }
    for (const error of boot.errors) warn(`pack: ${error}`);
    const others = otherKeyboards(g);
    if (others.length) log(`other keyboards in Steam: ${others.join('; ')}`);
    if (tryRun()) return;
    waitingSince = Date.now();
    log(`waiting for Steam objects: ${missingPrerequisites(g).join(', ')}`);
    startTimer(() => {
      if (tryRun()) return;
      if (Date.now() - waitingSince < PREREQ_TIMEOUT_MS) return;
      stopTimer();
      api.state = 'inactive';
      warn(`missing Steam objects: ${missingPrerequisites(g).join(', ')}; leaving the stock keyboard alone`);
    }, PREREQ_RETRY_MS);
  };

  const api: PolykeyApi = {
    version: VERSION,
    state: 'waiting',
    uninstall: () => {
      stopTimer();
      if (emojiSave !== null) {
        clearTimeout(emojiSave);
        void bridge.call('emoji.save', { state: emoji }); // a pending save is sent, not dropped
      }
      keys.releaseAll();
      bridge.close();
      unmount();
      api.state = 'uninstalled';
      log(`uninstalled ${VERSION}`);
    },
    bridgeReply: (reply) => bridge.receive(reply),
    debug: {
      status: () => `${api.state} keyboard=${stock ? STOCK : ring[current]} ${describeStatus(readStatus(statusStore))} `
        + `popup=${surface ? `${surface.win.innerWidth}x${surface.win.innerHeight}` : '-'}`,
      use: (id) => {
        const index = ring.indexOf(id);
        if (index < 0 && id !== STOCK) return `unknown keyboard ${id}; have ${[...ring, STOCK].join(', ')}`;
        stock = id === STOCK;
        switchTo(index < 0 ? current : index);
        return `keyboard ${id}`;
      },
    },
  };
  g[GLOBAL] = api;
  start();
  return api;
};
