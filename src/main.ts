// polykey in Steam's keyboard popup: renders the selected keyboard over the stock keys and sends what
// is typed through Steam. Fails safe: does nothing while required Steam objects are missing or fjk is
// active; never logs typed text; never leaves a key held. Idempotent: a re-injection replaces it.

import { createBar, type BarKeyboard } from './bar.js';
import { createBridge } from './bridge/client.js';
import { normalizeKey, readBoot, type ActionName, type Boot, type KeyboardDef, type KeyboardOptions, type KeyDef, type Layout, type Theme } from './core/catalog.js';
import { CLIPBOARD_CHORDS } from './core/keycodes.js';
import { NO_MODS, charText, flickText, kanaSide, press, pressText, type Effect, type Mods } from './core/keyboard.js';
import { chooseDelivery, graphemes } from './core/output/plan.js';
import { NO_WORD, closeUp, matchCase, rank, replaceWord, slotOrder, suggestPrefix, trackWord, type WordState } from './core/suggest.js';
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
import { NO_EMOJI_STATE, nextSet, setFor, steamItemEffects, steamKey, toneTable, useRecent, withTone, type EmojiState, type Tone } from './core/emoji.js';
import { loadSteamItems, steamItemImage, steamItems, steamItemsAvailable } from './host/steam/items.js';
import { createEmojiView, type EmojiView } from './ui/emoji.js';
import { composerOf } from './core/composers/index.js';
import type { ComposerContext } from './core/composers/composer.js';
import { nameFor } from './core/names.js';
import { idleHint, languageOf, spelled } from './core/languages.js';
import { latinTarget, modeLetters, pageLayout } from './core/pages.js';
import { NO_ENGLISH, commitEnglish, englishText, pressEnglish, type EnglishWord } from './core/english.js';
import { dictationLanguage, dictationLanguages, joinPhrase, spaceAfter, spacedText } from './core/dictation.js';
import { createDictation, createSpeechModels } from './dictation.js';
import { createUpdates } from './updates.js';
import { OPTIONS, offered, optionsFor, swipeLexicon, type OptionName } from './core/options.js';
import { SWIPE_WORDS, recentAfter, spaceBefore, swipeCase, swipeLetter } from './core/swipe.js';
import { fullName, languageName, ownName } from './ui/keyboards-page.js';
import { createSettingsView, type SettingsScroll, type SettingsTab, type SettingsValues, type SettingsView } from './ui/settings.js';
import { createView, type SwipeHandler, type View } from './ui/view.js';
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
/** Steam fetches the user's items on first ask: the open picker looks again this often, for so long. */
const STEAM_ITEMS_POLL_MS = 500;
export const STEAM_ITEMS_WAIT_MS = 15_000;
/** A swipe's words come back in tens of ms; keys pressed meanwhile wait for them, at most this long. */
const SWIPE_TIMEOUT_MS = 1500;

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

export const installPolykey = (g: SteamGlobals = globalThis): PolykeyApi => {
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
  // Keyboards in 英数 mode (a JIS keyboard's keys type their Latin legends); the rest are in かな mode.
  const latinMode = new Set<string>();
  // Keyboards showing a numbers and symbols page (the 12-key's ?123 is 1, its =\< page 2).
  const symbolsOn = new Map<string, 1 | 2>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let surface: Surface | null = null;
  let view: View | null = null;
  let panel: SettingsView | null = null;
  let picker: EmojiView | null = null;
  let page: 'keys' | 'settings' | 'emoji' = 'keys';
  // The settings page's tab, and the language whose layouts Keyboards shows (default: the current one's).
  let settingsTab: SettingsTab = 'general';
  let settingsScroll: SettingsScroll = {};
  let settingsLanguage: string | undefined;
  // The picker: its sets (picker packs), and each set's Recent, Favorites, the skin tone and the set last
  // shown, saved by the sidecar (~/.config/polykey/emoji.json).
  const sets = boot?.pickers ?? [];
  let emoji: EmojiState = { ...NO_EMOJI_STATE, ...boot?.emojiState };
  const tones = toneTable(sets);
  let emojiSave: ReturnType<typeof setTimeout> | null = null;
  /** While the picker is open and Steam is still fetching its items. */
  let steamWait: ReturnType<typeof setInterval> | null = null;
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
  /** A pick's space is the last thing sent: punctuation typed next takes its place. */
  let pickSpace = false;
  // Swipe typing: the last characters sent into this field (for the space before a swiped word; null
  // when unknown), the swiped word and its alternatives while a pick can still replace it, and the
  // decode in flight, which presses wait for so they never overtake the word.
  let recent: string | null = null;
  let swiped: { word: string; words: string[] } | null = null;
  let swipeWait: Promise<void> | null = null;
  const swipePrepared = new Set<string>();
  // Settings the page can change (the sidecar saves them); haptics and suggestions default on.
  const settings: SettingsValues = {
    theme: boot?.settings.theme ?? '',
    haptics: boot?.settings.haptics !== false,
    suggestions: boot?.settings.suggestions !== false,
    dictation: boot?.settings.dictation === true, // off until turned on
    dictationContinuous: boot?.settings.dictationContinuous === true,
    autoUpdate: boot?.settings.autoUpdate !== false, // on unless turned off
  };
  const tick = (win: Window, which: number): void => { if (settings.haptics) haptic(win, HAPTIC.enter, which); };

  const output = createOutput({
    getManager: () => pickKeyboardManager(g),
    getDelivery: () => chooseDelivery(keyboardMode(readStatus(statusStore)), 'auto'),
  });
  const keys = createKeySender({ getSetKeyState: () => getSetKeyState(g) });
  const bridge = createBridge(g);
  const dictation = createDictation({
    call: bridge.call, onState: (state) => view?.setMic(state), onText: (text) => placeDictated(text), log,
    onLevels: (levels) => view?.setMicLevels(levels), onListening: (on) => { if (on) dictatedTail = null; },
    continuous: () => settings.dictationContinuous, onPhrase: (text) => placePhrase(text),
    onRecognizing: (busy) => view?.setMicBusy(busy), onEnd: () => endPhrases(),
    onError: (code) => { if (code === 'no-model' || code === 'no-engine') showDictationTab(currentDictationLanguage()); },
  });
  const onDictationTab = (): boolean => page === 'settings' && settingsTab === 'dictation';
  const speech = createSpeechModels({
    call: bridge.call, active: () => settings.dictation && bridge.available(), warn,
    onCatalog: () => { if (onDictationTab()) render(); },
    // In place on the Dictation tab (drawn again when a model came or went), and on the mic key's foot.
    onStatus: (status) => {
      if (onDictationTab() && panel && !panel.setDictation(status)) render();
      view?.setMicProgress(speech.progress(currentDictationLanguage()));
    },
  });
  // The update line under the version on the Settings tab, followed only while it is on screen.
  const onSettingsTab = (): boolean => page === 'settings' && settingsTab === 'general';
  const updates = createUpdates({
    call: bridge.call, active: () => onSettingsTab() && bridge.available(), warn,
    onStatus: (status) => { if (onSettingsTab()) panel?.setUpdate(status); },
  });
  /** The language the Dictation tab shows; the current keyboard's until one is picked there. */
  let speechLanguage: string | undefined;
  /** A continuous session's last phrase while nothing else was typed since: what the next one joins. */
  let dictatedTail: string | null = null;

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
    else if (action === 'dictate' && settings.dictation) {
      const language = currentDictationLanguage();
      // Disabled while what it needs downloads (its foot shows the progress).
      if (dictation.state() !== 'idle' || speech.progress(language) === null) dictation.toggle(language);
    } else if (action === 'settings' || action === 'emoji' || action === 'abc') {
      if (page === 'emoji') saveEmoji(0);
      page = action === 'abc' ? 'keys' : action === 'emoji' && sets.length ? 'emoji' : action === 'emoji' ? 'keys' : 'settings';
      if (action === 'emoji' && !sets.length) log('emoji: no picker sets from the sidecar');
      render();
    }
    else if (action === 'next-set') {
      // The picker's mode key: on to the next set, in pack order. The picker opens on the saved set next time.
      const next = nextSet(sets, emoji.set);
      if (page !== 'emoji' || sets.length < 2 || !next) return;
      emoji = { ...emoji, set: next.id };
      saveEmoji(0);
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
    recent = recentAfter(recent, effects);
    pickSpace = false;
    // In order, one press after another, so fast typing never interleaves.
    queue = queue.then(async () => {
      for (const effect of effects) await apply(effect);
    }).catch((error) => warn('key failed:', errorKind(error)));
  };

  const boost = (used: string): void => { session.set(used.toLowerCase(), (session.get(used.toLowerCase()) ?? 0) + 1); };

  /** A keyboard whose typing is composed in the bar (any composer but direct). */
  const composes = (keyboard: KeyboardDef | undefined): boolean => composerOf(keyboard) !== null;
  /** Word suggestions: a keyboard that composes has them only in its Latin mode, in its candidate area. */
  const lexiconId = (): string | undefined => {
    const keyboard = boot?.catalog.keyboards[ring[current] as string];
    return composes(keyboard) && !latinMode.has(keyboard!.id) ? undefined : keyboard?.lexicon;
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
    if (composes(boot?.catalog.keyboards[ring[current] as string])) {
      suggested = words;
      showBar();
    } else view?.setSuggestions(slotOrder(words));
  };

  const refreshSuggestions = (): void => {
    const generation = ++suggestGeneration;
    if (swiped) {
      showWords(swiped.words); // the swiped word in the middle, its alternatives beside it
      return;
    }
    const inBar = composes(boot?.catalog.keyboards[ring[current] as string]);
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
  /** A keyboard's language pack (its letters, bar words, idle hint, dictation language). */
  const languageFor = (keyboard: KeyboardDef | undefined) => languageOf(boot?.catalog.languages, keyboard);
  /** What a keyboard's composer reads: its options as set, its table and its main layout. */
  const contextOf = (keyboard: KeyboardDef): ComposerContext => ({
    options: optionsFor(keyboard, keyboardOptions[keyboard.id]),
    table: keyboard.table ? boot?.catalog.tables?.[keyboard.table] : undefined,
    layout: boot?.catalog.layouts[keyboard.layout],
  });
  /** The current keyboard as the bar drives it; null when its keys type at once. */
  const barKeyboard = (): BarKeyboard | null => {
    const keyboard = currentKeyboard();
    const composer = composerOf(keyboard);
    return keyboard && composer ? { composer, ctx: contextOf(keyboard), converter: keyboard.converter } : null;
  };
  /** Whether the keyboard's JIS keys type their Latin legends while composing (romaji input). */
  const latinKeys = (keyboard: KeyboardDef | undefined): boolean => {
    const composer = composerOf(keyboard);
    return !!keyboard && !!composer && composer.latinKeys(contextOf(keyboard));
  };
  // The bar: what the keyboard's composer has composed, with the converter's candidates (src/bar.ts).
  const bar = createBar({
    call: bridge.call, available: bridge.available, warn,
    enqueue: (effects) => enqueue(effects), show: () => showBar(), keyboard: barKeyboard,
  });

  /** Dictated text goes into the composition (a Japanese reading), not typed: the composer takes it, and not in the Latin mode. */
  const dictatesIntoBar = (keyboard: KeyboardDef | undefined): boolean =>
    composerOf(keyboard)?.insert !== undefined && !(keyboard && latinMode.has(keyboard.id));
  /** The mic leaves the reading or English word where it is: the dictated text joins it. */
  const dictates = (key: KeyDef): boolean => key.type === 'action' && key.action === 'dictate' && settings.dictation;
  /** Fn is on and the key has an Fn variant (JIS: Fn+1 is F1): it goes out as that key, not into a buffer. */
  const fnKey = (key: KeyDef): boolean => mods.fn !== 'off' && (key.type === 'char' || key.type === 'key') && !!key.fn;

  /** While a swipe is decoding, run this after its word instead (true: deferred). */
  const afterSwipe = (fn: () => void): boolean => {
    if (!swipeWait) return false;
    void swipeWait.then(fn);
    return true;
  };

  /**
   * Into or out of the keyboard's Latin mode, for every mode key: what waits in the bar goes first (the
   * composition going in, the English word coming out), and suggestions start afresh.
   */
  const setLatin = (keyboard: KeyboardDef, on: boolean): void => {
    const was = latinMode.has(keyboard.id);
    if (on && !was) {
      bar.flush();
      latinMode.add(keyboard.id);
    } else if (!on && was) {
      sendEnglish();
      latinMode.delete(keyboard.id);
    }
    setWord(NO_WORD); // suggestions only for words typed in the Latin mode
    if (keyboard.pages?.latin) render(); // a page of its own (the 12-key's ABC keys)
    else {
      view?.setMode(latinMode.has(keyboard.id));
      view?.update(mods);
    }
  };

  const onKey = (key: KeyDef, alternate?: string, repeat = false): void => {
    if (afterSwipe(() => onKey(key, alternate, repeat))) return;
    if (surface && !repeat) tick(surface.win, hand); // one tick per press, not per repeat
    if (!dictates(key)) dictatedTail = null; // typed in between: the next phrase joins what is known now
    if (swiped && key.type !== 'mod') { // Shift or Caps for the next word keeps them
      const word = swiped.word;
      swiped = null; // any other key ends the alternatives
      // Backspace straight after a swipe takes the whole word back, as phones do (in 英数 mode, out of the bar).
      if (key.type === 'key' && key.key === 'Backspace' && !repeat && mods.ctrl === 'off' && mods.alt === 'off') {
        if (composes(currentKeyboard())) {
          en = NO_ENGLISH;
          refreshSuggestions();
        } else sendEffects(graphemes(word).map((): Effect => ({ kind: 'key', key: 'Backspace' })));
        return;
      }
    }
    if (key.type === 'action' && key.action === 'next-keyboard' && alternate !== undefined) {
      const index = ring.indexOf(alternate); // picked from the menu held on 🌐
      if (index >= 0 && index !== current) switchTo(index);
      return;
    }
    const keyboard = currentKeyboard();
    const options = optionsFor(keyboard, keyboard ? keyboardOptions[keyboard.id] : undefined);
    const latin = keyboard ? latinMode.has(keyboard.id) : false;
    // The mode key (한/영) switches between the keyboard's own letters and its Latin mode; 英数 and かな (the
    // Mac's two keys) are one-way switches, かな while typing kana changing the reading's form instead.
    const toLatin = latinTarget(key, latin);
    if (keyboard && toLatin !== undefined) {
      setLatin(keyboard, toLatin);
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
    // The Latin mode of a keyboard that composes: English words wait in the bar with their suggestions.
    if (keyboard && composes(keyboard) && page === 'keys' && latin) {
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
        showBar();
        return;
      }
      if (key.type !== 'mod' && !dictates(key)) sendEnglish(); // any other key sends the word first
    }
    if (keyboard && composes(keyboard) && page === 'keys' && !latin) {
      // A typed key goes to the composer with Shift applied; with Ctrl, Alt or Super it is a shortcut.
      const chording = mods.ctrl !== 'off' || mods.alt !== 'off' || mods.super !== 'off' || fnKey(key);
      const side = kanaSide(key, !latinKeys(keyboard)); // a JIS key types its kana (its Latin legend with romaji input)
      const typed = side.type === 'char' && !chording ? (alternate ?? charText(side, mods)) : undefined;
      const handled = bar.press(key, { ...(key.type === 'flick' && alternate !== undefined ? { flicked: alternate } : {}), ...(typed !== undefined ? { typed } : {}) });
      if (handled) {
        if (typed !== undefined) {
          mods = pressText(mods, '').mods; // a one-shot Shift is used up
          view?.update(mods);
        }
        return;
      }
      // Any other key sends what waits first (a modifier only arms, so it does not).
      if (key.type !== 'mod' && !dictates(key)) bar.flush();
    }
    const result = alternate === undefined ? press(mods, key)
      : pressText(mods, key.type === 'flick' ? flickText(alternate, mods) : alternate); // a flicked letter takes Shift
    mods = result.mods;
    view?.update(mods);
    const effects = pickSpace ? closeUp(result.effects) : result.effects;
    const tracked = trackWord(word, effects);
    if (tracked.ended) boost(tracked.ended);
    setWord(tracked.state);
    enqueue(effects);
  };

  /**
   * Draw the bar: what is composed and its candidates, else the English word and its suggestions; keys
   * follow, in the words of the keyboard's language (空白 → 変換).
   */
  const showBar = (): void => {
    if (!view) return;
    const shown = bar.shown();
    const language = languageFor(currentKeyboard());
    if (shown) {
      view.setComposition(shown.composition);
      view.setLabels(spelled(shown.labels, language));
    } else {
      // The Latin mode: English word suggestions where the candidates go; picking one replaces the word typed.
      view.setComposition(en.chars.length ? {
        before: en.chars.slice(0, en.caret).join(''), after: en.chars.slice(en.caret).join(''), candidates: suggested, selected: -1,
      } : null);
      view.setLabels(spelled(en.chars.length ? { Enter: 'confirm' } : {}, language));
    }
    view.update(mods);
  };

  const onCandidate = (text: string, index: number): void => {
    if (afterSwipe(() => onCandidate(text, index))) return;
    swiped = null; // in 英数 mode a pick sends the word, as for any suggestion
    if (!bar.composing() && en.chars.length) {
      // A suggestion for the English word: sent in its place, with a space.
      if (surface) tick(surface.win, hand);
      boost(text);
      enqueue([{ kind: 'text', text: `${text} ` }]);
      en = NO_ENGLISH;
      refreshSuggestions();
      return;
    }
    if (surface) tick(surface.win, hand);
    bar.pick(text, index);
  };

  /**
   * Dictated text, where typing would put it: into the composition in the bar, for its candidates (or
   * typed at once, as set), where the composer takes it; else sent with the spacing a typed phrase would
   * have, after what is composed. No modifier stays armed or held.
   */
  const placeDictated = (text: string, join?: (before: string) => string): void => {
    if (afterSwipe(() => placeDictated(text, join))) return;
    swiped = null; // the swiped word's alternatives would replace the wrong text
    keys.releaseAll();
    mods = { ...NO_MODS, caps: mods.caps };
    view?.update(mods);
    const keyboard = currentKeyboard();
    const latin = keyboard ? latinMode.has(keyboard.id) : false;
    if (dictatesIntoBar(keyboard)) {
      bar.dictate(text);
      return;
    }
    // A syllable being composed goes first; it ends the word being typed.
    const composed = bar.shown()?.composition;
    const syllable = composed && 'before' in composed ? composed.before + composed.after : '';
    bar.flush();
    const inLatin = composes(keyboard) && latin; // the English word in the bar
    const language = dictationLanguage(keyboard, latin, languageFor(keyboard));
    const before = inLatin ? en.chars.join('') : syllable || word.word; // the word being typed: what is known before the caret
    const typed = join ? join(before) : spacedText(text, language, before !== '');
    if (inLatin) sendEnglish(); // the Latin mode: the English word goes first
    else setWord(NO_WORD);
    enqueue([{ kind: 'text', text: typed }]);
  };

  /** A continuous session's phrase: joined to the one before (or the word being typed) by the space rule. */
  const placePhrase = (text: string): void => {
    const tail = dictatedTail;
    placeDictated(text, (before) => joinPhrase(tail ?? before, text));
    dictatedTail = text.trim();
  };
  /** The session ended: a space after its last phrase, where the next typed word would need one. */
  const endPhrases = (): void => {
    if (afterSwipe(endPhrases)) return;
    const keyboard = currentKeyboard();
    if (dictatedTail && !dictatesIntoBar(keyboard) && spaceAfter(dictatedTail)) enqueue([{ kind: 'text', text: ' ' }]);
    dictatedTail = null;
  };

  const currentDictationLanguage = (): string => {
    const keyboard = currentKeyboard();
    return dictationLanguage(keyboard, keyboard ? latinMode.has(keyboard.id) : false, languageFor(keyboard));
  };

  /** Settings → Dictation at `language` (the mic without the engine, or without a model for the language). */
  const showDictationTab = (language: string): void => {
    if (page === 'emoji') saveEmoji(0);
    page = 'settings';
    settingsTab = 'dictation';
    speechLanguage = language;
    render();
  };

  const onSuggestion = (chosen: string): void => {
    if (afterSwipe(() => onSuggestion(chosen))) return;
    if (surface) tick(surface.win, hand);
    if (swiped) {
      // An alternative replaces the swiped word; the swiped word itself is kept. Either way a space
      // follows and the alternatives go, as for a typed word.
      const before = swiped.word;
      swiped = null;
      boost(chosen);
      sendEffects(chosen === before ? [{ kind: 'text', text: ' ' }]
        : [...graphemes(before).map((): Effect => ({ kind: 'key', key: 'Backspace' })), { kind: 'text', text: `${chosen} ` }]);
      pickSpace = true;
      return;
    }
    const typed = word.word;
    boost(chosen);
    setWord(NO_WORD);
    enqueue(replaceWord(typed, chosen));
    pickSpace = true;
  };

  /**
   * The word list a swipe decodes against now, if the keyboard swipes: while its swipe option is on, and
   * on a Japanese keyboard only in 英数 mode on its letters (never in kana mode or on a symbols page).
   */
  const swipeNow = (): string | undefined => {
    const keyboard = currentKeyboard();
    if (!keyboard || page !== 'keys' || (composes(keyboard) && (!latinMode.has(keyboard.id) || symbolsOn.has(keyboard.id)))) return undefined;
    return swipeLexicon(keyboard, keyboardOptions[keyboard.id]);
  };

  /**
   * A swiped word on a Japanese keyboard in 英数 mode joins the English word flow (core/english.ts): a
   * word waiting in the bar is sent with a space, the swiped one waits there in its place, its
   * alternatives where the suggestions go; Space, 確定, a pick or a mode switch sends it as usual.
   */
  const swipeIntoBar = (words: string[]): void => {
    const waiting = englishText(en);
    if (waiting) boost(waiting);
    const before = waiting ? `${waiting} ` : spaceBefore(recent, true) ? ' ' : '';
    if (before) enqueue([{ kind: 'text', text: before }]);
    const chars = graphemes(words[0]!);
    en = { chars, caret: chars.length, cycle: null };
    swiped = { word: words[0]!, words };
    refreshSuggestions();
  };

  /** A swipe on the letters: the sidecar decodes it; the best word is typed, the others offered. */
  const onSwipe: SwipeHandler = (path, letters, keyWidth) => {
    if (afterSwipe(() => onSwipe(path, letters, keyWidth))) return;
    const lexicon = swipeNow();
    if (!lexicon || !bridge.available()) return;
    if (surface) tick(surface.win, hand);
    swiped = null;
    dictatedTail = null; // typed in between: the next phrase joins what is known now
    // Shift applies to the word as it does to a letter: once for a capital, locked (or Caps) for all.
    const { shift, caps } = mods;
    mods = pressText(mods, '').mods;
    view?.update(mods);
    const round = (v: number): number => Math.round(v * 10) / 10;
    swipeWait = bridge.call('swipe', { lexicon, path: path.map((p) => [round(p.x), round(p.y)]), keys: letters, keyWidth: round(keyWidth),
      limit: SWIPE_WORDS }, SWIPE_TIMEOUT_MS).then((reply) => {
      swipeWait = null;
      const found = reply.ok && Array.isArray(reply['words']) ? (reply['words'] as unknown[]).filter((w): w is string => typeof w === 'string' && w !== '') : [];
      if (!found.length) {
        log(reply.ok ? 'swipe: no word matched' : `swipe failed: ${reply.error ?? '?'}`); // never the path or words
        return;
      }
      const words = [...new Set(found.map((w) => swipeCase(w, shift, caps)))];
      if (composes(currentKeyboard())) {
        swipeIntoBar(words);
        return;
      }
      const text = `${spaceBefore(recent) ? ' ' : ''}${words[0]}`;
      boost(words[0]!);
      swiped = { word: words[0]!, words };
      sendEffects([{ kind: 'text', text }]);
    }).catch((error) => {
      swipeWait = null; // presses waiting for the word go on
      warn('swipe failed:', errorKind(error));
    });
  };

  /** Have the sidecar load the word list a swipe needs before the first swipe (once per list). */
  const prepareSwipe = (lexicon: string | undefined, layout: Layout): void => {
    if (!lexicon || swipePrepared.has(lexicon) || !bridge.available()) return;
    const letters = new Set(layout.rows.flat().map(normalizeKey).flatMap((k) => (k.type === 'char' && swipeLetter(k.char) ? [k.char.toLowerCase()] : [])));
    if (letters.size < 2) return; // a page without letters (the 12-key's kana): when its letters show
    swipePrepared.add(lexicon);
    void bridge.call('swipe', { lexicon, keys: Object.fromEntries([...letters].map((c) => [c, [0, 0]])), prepare: true }, 10_000);
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
    if (steamWait !== null) clearInterval(steamWait);
    steamWait = null;
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

  /**
   * Show the current keyboard, or Steam's own with a way back. Settings drawn again keeps its lists where
   * they were, `fresh` (a list now showing something else) at the top; left, it opens at the top next time.
   */
  const render = (fresh?: string): void => {
    if (!surface || !boot) return;
    settingsScroll = page === 'settings' ? { ...settingsScroll, ...panel?.scroll() } : {};
    if (fresh) settingsScroll[fresh] = 0;
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
    if (page === 'emoji' && sets.length) {
      const owned = () => steamItems(g).map((item) => ({ item, image: steamItemImage(g, item) }));
      const steamLoading = loadSteamItems(g);
      picker = createEmojiView(surface.doc, surface.shadow, theme, {
        sets,
        language: keyboard?.language,
        steam: owned(),
        steamAvailable: steamItemsAvailable(g),
        steamLoading,
        tones,
      }, emoji, { onItem: typeItem, onTone, onSteam, onFavorites, onClearRecent });
      if (steamLoading) {
        const until = Date.now() + STEAM_ITEMS_WAIT_MS;
        steamWait = setInterval(() => {
          if (loadSteamItems(g) && Date.now() < until) return;
          if (steamWait !== null) clearInterval(steamWait);
          steamWait = null;
          picker?.setSteam(owned(), false);
        }, STEAM_ITEMS_POLL_MS);
      }
      const row = boot.catalog.layouts[EMOJI_ROW];
      if (row) {
        // The mode key shows the set it goes to, as its pack says: an icon, or a text (:-)); with one set the row has none.
        const next = sets.length > 1 ? nextSet(sets, emoji.set) : undefined;
        const modeKey = (k: KeyDef | string): boolean => typeof k !== 'string' && k.type === 'action' && k.action === 'next-set';
        const rows = row.rows.map((keys) => keys.filter((k) => next || !modeKey(k))
          .map((k) => (!modeKey(k) ? k : next?.key.label ? { ...(k as KeyDef), label: next.key.label, icon: null } : { ...(k as KeyDef), icon: next?.key.icon ?? null })));
        // Its back key reads the current mode's letters (あいう, ABC).
        view = createView(surface.doc, surface.shadow, { ...row, rows }, theme, onKey, onSuggestion, undefined,
          { letters: modeLetters(keyboard, latinMode.has(id), languageFor(keyboard)) });
        view.update(mods);
      }
      applyBounds();
    } else if (page === 'settings') {
      panel = createSettingsView(surface.doc, surface.shadow, theme, settings, {
        themes: Object.values(boot.catalog.themes).map((t) => ({ id: t.id, name: nameFor(t.name, keyboard?.language), swatch: [t.colors.surface, t.colors.key, t.colors.accent] })),
        version: VERSION,
        errors: boot.errors,
        suggestions: !!keyboard?.lexicon,
        keyboardName: keyboard ? fullName(keyboard) : id,
        // The dictation row only while dictation is on.
        options: offered(keyboard).filter((name) => name !== 'dictationCommit' || settings.dictation).map((name) => ({ id: name, ...OPTIONS[name], value: optionsFor(keyboard, keyboardOptions[id])[name] })),
        tab: settingsTab,
        keyboards: {
          all: Object.values(boot.catalog.keyboards).map((k) => ({ id: k.id, name: k.name, language: k.language ?? 'und' })),
          ring,
          language: settingsLanguage ?? keyboard?.language ?? 'en',
        },
        update: updates.status,
        dictation: {
          catalog: speech.catalog, status: speech.status,
          languages: dictationLanguages(Object.values(boot.catalog.keyboards), languageFor),
          language: speechLanguage ?? currentDictationLanguage(),
        },
      }, {
        onTab: (tab) => { settingsTab = tab; render(); },
        onLanguage: (code) => { settingsLanguage = code; render('keyboards:lays'); }, // its layouts from the top
        onKeyboards: changeKeyboards,
        onChange: changeSettings,
        onOption: (name, value) => changeOption(id, name as OptionName, value),
        onSpeechLanguage: (code) => { speechLanguage = code; render('dictation:models'); }, // its models (or Downloaded) from the top
        onChoose: (language, model) => {
          speech.choose(language, model);
          if (surface) tick(surface.win, hand);
          render();
        },
        onDownload: speech.download,
        onDelete: speech.delete,
        onStock: () => { page = 'keys'; stock = true; switchTo(current); },
        onClose: () => { page = 'keys'; render(); },
        onUpdate: (action) => {
          if (surface) tick(surface.win, hand);
          updates.run(action);
        },
      });
      applyBounds();
      panel.setScroll(settingsScroll); // sized first, so the lists can scroll
      updates.follow(); // what the updater says now (and while a check or download runs)
    } else {
      // Swipes need the sidecar to decode them; without it a press that moves off a letter still types it.
      const swipes = bridge.available() ? swipeLexicon(keyboard, keyboardOptions[id]) : undefined;
      prepareSwipe(swipes, layout);
      // With dictation off there is no mic on the toolbar (no gap either); Settings → Dictation turns it on.
      // With one keyboard in your list 🌐 has nowhere to go: the layout's rows without it.
      const rows = ring.length <= 1 && layout.aloneRows ? layout.aloneRows : layout.rows;
      const shown = settings.dictation ? { ...layout, rows }
        : { ...layout, rows, toolbar: (layout.toolbar ?? []).filter((k) => !(k.type === 'action' && k.action === 'dictate')) };
      const hint = idleHint(keyboard, languageFor(keyboard));
      view = createView(surface.doc, surface.shadow, shown, theme, onKey, onSuggestion, onCandidate,
        { side: optionsFor(keyboard, keyboardOptions[id]).candidatesLeft, hints: optionsFor(keyboard, keyboardOptions[id]).flickHints,
          onSwipe: swipes ? onSwipe : undefined, canSwipe: () => swipeNow() !== undefined,
          latin: latinMode.has(id), romaji: latinKeys(keyboard), symbols: symbolsOn.get(id) ?? 0, letters: modeLetters(keyboard, latinMode.has(id), languageFor(keyboard)),
          otherLetters: modeLetters(keyboard, !latinMode.has(id), languageFor(keyboard)),
          // Holding 🌐: each keyboard's language small above its layout.
          keyboardMenu: { ids: ring, names: ring.map((k) => {
            const def = boot.catalog.keyboards[k];
            return def ? `${def.language ? `${languageName(def.language)}\n` : ''}${ownName(def)}` : k;
          }) },
          languageFont: languageFor(keyboard)?.font,
          ...(hint ? { placeholder: hint } : {}) });
      view.update(mods);
      applyBounds();
      refreshSuggestions();
      showBar();
    }
    view?.setMic(dictation.state());
    view?.setMicProgress(speech.progress(currentDictationLanguage()));
    if (!speech.status || onDictationTab()) speech.follow();
    stopCursor = onCursor(win, (x, y, which) => {
      hand = which;
      // A tick as the laser crosses keys or the picker's cells, and as a held key's or emoji's pick moves between choices.
      const picked = picker?.hoverAt(x, y) ?? false;
      if ((view ?? panel)?.hoverAt(x, y) || picked) tick(win, which);
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

  /** Change the shown set's Recent, and show it. Recent is typed content: never logged. */
  const setRecent = (recent: (was: string[]) => string[]): void => {
    const shown = setFor(sets, emoji.set);
    if (!shown?.recent) return; // a set without Recent keeps none
    const id = shown.id;
    emoji = { ...emoji, recent: { ...emoji.recent, [id]: recent(emoji.recent[id] ?? []) } };
    picker?.update(emoji);
  };

  /** An item of the shown set is typed (an emoji in the chosen skin tone) and kept in the set's Recent. */
  const typeItem = (base: string, fromRecent: boolean, room: number): void => {
    if (surface) tick(surface.win, hand);
    swiped = null;
    sendEffects([{ kind: 'text', text: setFor(sets, emoji.set)?.tones ? withTone(base, emoji.tone, tones) : base }]);
    setRecent((was) => useRecent(was, base, fromRecent, room));
    saveEmoji();
  };

  const onSteam = (item: Parameters<typeof steamItemEffects>[0], fromRecent: boolean, room: number): void => {
    if (surface) tick(surface.win, hand);
    swiped = null;
    sendEffects(steamItemEffects(item));
    setRecent((was) => useRecent(was, steamKey(item), fromRecent, room));
    saveEmoji();
  };

  /** A skin tone picked from a hold: it applies everywhere from now on, starting with this emoji. */
  const onTone = (tone: Tone, base: string, room: number): void => {
    emoji = { ...emoji, tone };
    typeItem(base, false, room);
  };

  const onClearRecent = (): void => {
    if (surface) tick(surface.win, hand);
    setRecent(() => []);
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
    bar.pause();
    void bridge.call('settings.save', { settings: { keyboardOptions } }).then((reply) => {
      if (!reply.ok) warn(`settings not saved: ${reply.error ?? '?'}`);
    });
    if (surface) tick(surface.win, hand);
    render();
  };

  /** Apply settings at once and have the sidecar save them (a failed save is logged, not fatal). */
  const changeSettings = (changes: Partial<SettingsValues>): void => {
    Object.assign(settings, changes);
    if (changes.dictation === false) {
      dictation.cancel(); // the sidecar also stops its helper and its downloads
      speech.forget();
    }
    void bridge.call('settings.save', { settings: changes }).then((reply) => {
      if (!reply.ok) warn(`settings not saved: ${reply.error ?? '?'}`);
      else if (changes.dictation) speech.follow(); // turning it on starts the engine download
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
    swiped = null;
    dictation.cancel(); // its language was the keyboard's
    bar.leave(); // switching keyboards sends what waits in the bar
    if (en.chars.length) enqueue(commitEnglish(en));
    en = NO_ENGLISH;
    symbolsOn.clear(); // a keyboard comes back on its letters
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
      swiped = null;
      recent = null; // a new field: what is before the cursor is unknown
      pickSpace = false;
      setWord(NO_WORD); // a new field: we only ever replace letters we typed after this
      if (!open) {
        bar.drop(); // the field is gone: an unsent reading is dropped, not typed elsewhere
        showBar();
        keys.releaseAll(); // closing must never leave a key held
        dictation.cancel(); // nor the mic listening
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
      dictation.cancel();
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
