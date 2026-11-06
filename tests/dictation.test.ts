// @vitest-environment jsdom
// Dictation on the page: the controller against a fake bridge, and the mic key, text placement and
// settings through installPolykey with a fake sidecar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeReply } from '../src/bridge/client.js';
import { SURFACE_ID } from '../src/host/steam/popup.js';
import { ERROR_MS, MAX_SESSION_MS, createDictation } from '../src/dictation.js';
import { BOOT_GLOBAL, GLOBAL, installPolykey, type PolykeyApi } from '../src/main.js';
import { bundledBoot } from './boot.js';
import { MINIMAL, fakeManager, fakePopupWindow, fakeSteam, type FakePopupWindow } from './fake-steam.js';

let logged: string[];
let installed: PolykeyApi[];

beforeEach(() => {
  vi.useFakeTimers();
  logged = [];
  installed = [];
  const capture = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
});
afterEach(() => {
  for (const api of installed) api.uninstall();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Req = Record<string, unknown> & { op: string; id: number };

const ready = { state: 'ready' };
const CATALOG = {
  ok: true,
  engine: { version: '0.4.1', attribution: 'transcribe.cpp by its authors (MIT)', size: 18_185_054 },
  models: [
    {
      id: 'whisper-small',
      name: 'Whisper small',
      languages: ['*'],
      size: 269_751_136,
      licence: 'Apache-2.0',
      attribution: 'Whisper by OpenAI',
      credit: 'OpenAI',
      ramMB: 450,
      notes: '99 languages.',
      handy: { cpuRtf: 5.9, error: { en: 6.5, ja: 12.8 } },
    },
    {
      id: 'parakeet',
      name: 'Parakeet',
      languages: ['en'],
      size: 729_574_912,
      licence: 'CC-BY-4.0',
      attribution: 'Parakeet by NVIDIA, CC BY 4.0',
      credit: 'NVIDIA · 8-bit GGUF by handy-computer',
      ramMB: 1000,
      notes: 'English.',
      handy: { cpuRtf: 14.3, error: { en: 4.1 } },
    },
    {
      id: 'sensevoice',
      name: 'SenseVoice Small',
      languages: ['ja', 'zh', 'en'],
      size: 252_684_608,
      licence: 'FunASR-1.1',
      attribution: 'SenseVoiceSmall by FunAudioLLM',
      credit: 'FunAudioLLM',
      ramMB: 400,
      notes: 'CJK.',
      handy: { cpuRtf: 19.7, error: { en: 7.1, ja: 7.6 } },
    },
  ],
};
/** Everything in place: the engine and Parakeet for English. */
const READY = {
  ok: true,
  enabled: true,
  rev: 1,
  engine: ready,
  models: { 'whisper-small': { state: 'missing' }, parakeet: ready, sensevoice: { state: 'missing' } },
  choices: {},
};

/**
 * A fake sidecar: dictation.wait is answered when the test moves the session on with phase(); a
 * dictation.status that waits for a change (since) is answered when the test calls change().
 */
const fakeSidecar = (g: Record<string, unknown>, status: Record<string, unknown> = {}) => {
  const asked: Req[] = [];
  let waiting: ((body: Record<string, unknown>) => void) | null = null;
  let current: Record<string, unknown> = { ...READY, ...status };
  let held: ((body: Record<string, unknown>) => void) | null = null;
  let start: Record<string, unknown> = { ok: true, session: 1 };
  let swiping: ((words: string[]) => void) | null = null;
  const answer = (id: number, body: Record<string, unknown>) =>
    setTimeout(() => (g[GLOBAL] as PolykeyApi).bridgeReply({ id, ...body }), 1);
  g['polykeyBridge'] = (payload: string) => {
    const req = JSON.parse(payload) as Req;
    asked.push(req);
    if (req.op === 'dictation.wait') {
      waiting = (body) => answer(req.id, { ok: true, session: req['session'], ...body });
      return;
    }
    if (req.op === 'swipe' && !req['prepare']) swiping = (words) => answer(req.id, { ok: true, words });
    else if (req.op === 'dictation.start') answer(req.id, start);
    else if (req.op === 'dictation.catalog') answer(req.id, CATALOG);
    else if (req.op === 'dictation.status' && req['since'] !== undefined) held = (body) => answer(req.id, body);
    else if (['dictation.status', 'dictation.download', 'dictation.delete'].includes(req.op)) answer(req.id, current);
    else if (req.op === 'convert')
      answer(req.id, { ok: true, segments: [{ reading: req['reading'], candidates: [req['reading']] }] });
    else if (req.op === 'predict') answer(req.id, { ok: true, predictions: [] });
    else if (req.op === 'desktop.prepare') answer(req.id, { ok: false, error: 'not-desktop' });
    else answer(req.id, { ok: true });
  };
  return {
    asked,
    ops: () => asked.map((r) => r.op).filter((op) => op.startsWith('dictation.') || op === 'settings.save'),
    phase: async (body: Record<string, unknown>) => {
      const w = waiting;
      waiting = null;
      w!(body);
      await vi.advanceTimersByTimeAsync(20);
    },
    /** The status changes: a waiting dictation.status answers with it. */
    change: async (next: Record<string, unknown>) => {
      current = { ...current, ...next, rev: Number(current['rev']) + 1 };
      const h = held;
      held = null;
      h?.(current);
      await vi.advanceTimersByTimeAsync(20);
    },
    holding: () => held !== null,
    /** A swipe being decoded gets its words. */
    swiped: async (words: string[]) => {
      swiping!(words);
      await vi.advanceTimersByTimeAsync(20);
    },
    failStart: (error: string) => {
      start = { ok: false, error };
    },
  };
};

const setup = (settings: Record<string, unknown> = {}, status: Record<string, unknown> = {}) => {
  const popup = fakePopupWindow();
  const manager = fakeManager(true);
  const steam = fakeSteam({ popup, managers: [manager], status: MINIMAL, keyState: true });
  const boot = bundledBoot();
  Object.assign(boot.settings, settings);
  steam.g[BOOT_GLOBAL] = boot;
  const sidecar = fakeSidecar(steam.g, status);
  const api = installPolykey(steam.g);
  installed.push(api);
  return { ...steam, popup, manager, api, sidecar, typed: () => manager.calls.map(([k]) => k).join('') };
};

const shadowOf = (popup: FakePopupWindow) => popup.document.getElementById(SURFACE_ID)!.shadowRoot!;
const key = (popup: FakePopupWindow, id: string) =>
  [...shadowOf(popup).querySelectorAll<HTMLElement>('.key')].find((el) => el.dataset['k'] === id)!;
const touch = async (el: HTMLElement) => {
  el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(200);
};
const tap = async (popup: FakePopupWindow, id: string) => touch(key(popup, id));
const mic = (popup: FakePopupWindow) =>
  [...key(popup, 'dictate').classList].filter((c) => ['listening', 'recognizing', 'err', 'fetching'].includes(c));
const pre = (popup: FakePopupWindow) => shadowOf(popup).querySelector('.comp.on .pre')?.textContent || null;
const row = (popup: FakePopupWindow, name: string) =>
  [...shadowOf(popup).querySelectorAll<HTMLElement>('.panel .row')].find(
    (r) => r.querySelector('.name')?.textContent === name,
  );
const panel = (popup: FakePopupWindow) => shadowOf(popup).querySelector('.panel')!;
/** Settings → Dictation, from the keys. */
const openTab = async (popup: FakePopupWindow) => {
  await tap(popup, 'settings');
  await touch([...panel(popup).querySelectorAll<HTMLElement>('.opt.tab')].find((o) => o.textContent === 'Dictation')!);
};
const flipDictation = async (popup: FakePopupWindow) =>
  touch(row(popup, 'Dictation')!.querySelector<HTMLElement>('.switch')!);
const closePanel = async (popup: FakePopupWindow) => touch(panel(popup).querySelector<HTMLElement>('.opt.close')!);

describe('dictation controller', () => {
  const fake = () => {
    const calls: [string, Record<string, unknown>][] = [];
    const replies: Record<string, (args: Record<string, unknown>) => Partial<BridgeReply>> = {
      'dictation.start': () => ({ ok: true, session: 4 }),
    };
    const call = async (op: string, args: Record<string, unknown> = {}) => {
      calls.push([op, args]);
      return { id: 0, ok: true, ...replies[op]?.(args) } as BridgeReply;
    };
    return { calls, replies, call };
  };

  it('starts, follows the phases and hands over the text; a second press stops', async () => {
    const { calls, call } = fake();
    const states: string[] = [];
    const texts: string[] = [];
    let answer: (phase: Partial<BridgeReply>) => void = () => {};
    const held = async (op: string, args: Record<string, unknown> = {}) => {
      if (op !== 'dictation.wait') return call(op, args);
      calls.push([op, args]);
      return new Promise<BridgeReply>((resolve) => {
        answer = (r) => resolve({ id: 0, ok: true, ...r });
      });
    };
    const d = createDictation({
      call: held,
      onState: (s) => states.push(s),
      onText: (t) => texts.push(t),
      log: () => {},
    });
    d.toggle('en');
    await vi.advanceTimersByTimeAsync(0);
    expect(d.state()).toBe('listening');
    d.toggle('en');
    expect(calls.map(([op]) => op)).toEqual(['dictation.start', 'dictation.wait', 'dictation.stop']);
    expect(calls[1]![1]).toEqual({ session: 4, phase: 'listening', seq: -1, timeoutMs: 15000 });
    expect(calls[2]![1]).toEqual({ session: 4 });
    answer({ phase: 'transcribing' });
    await vi.advanceTimersByTimeAsync(0);
    expect(d.state()).toBe('transcribing');
    expect(calls[3]).toEqual(['dictation.wait', { session: 4, phase: 'transcribing', seq: -1, timeoutMs: 15000 }]);
    answer({ phase: 'done', text: 'hi' });
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['listening', 'transcribing', 'idle']);
    expect(texts).toEqual(['hi']);
  });

  it('a failed start shows an error briefly, logged as its code and named to onError', async () => {
    const { replies, call } = fake();
    const lines: string[] = [];
    const errors: string[] = [];
    const listening: boolean[] = [];
    replies['dictation.start'] = () => ({ ok: false, error: 'no-model' });
    const d = createDictation({
      call,
      onState: () => {},
      onText: () => {},
      log: (l) => lines.push(l),
      onError: (c) => errors.push(c),
      onListening: (on) => listening.push(on),
    });
    d.toggle('en');
    await vi.advanceTimersByTimeAsync(0);
    expect(d.state()).toBe('error');
    expect(lines).toEqual(['dictation: no-model']);
    expect(errors).toEqual(['no-model']);
    expect(listening).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(ERROR_MS);
    expect(d.state()).toBe('idle');
  });

  it('reports the bars while listening, and listening starting and stopping', async () => {
    const { replies, call } = fake();
    const answers: Partial<BridgeReply>[] = [
      { phase: 'listening', seq: 1, bars: [0, 0, 0, 0, 5] },
      { phase: 'done', text: 'x' },
    ];
    replies['dictation.wait'] = () => answers.shift()!;
    const levels: number[][] = [];
    const listening: boolean[] = [];
    const d = createDictation({
      call,
      onState: () => {},
      onText: () => {},
      log: () => {},
      onLevels: (l) => levels.push(l),
      onListening: (on) => listening.push(on),
    });
    d.toggle('en');
    await vi.advanceTimersByTimeAsync(0);
    expect(levels).toEqual([[0, 0, 0, 0, 5]]);
    expect(listening).toEqual([true, false]);
  });

  it('after a failed recognition the mic comes back and takes a new press', async () => {
    const { calls, replies, call } = fake();
    const answers: Partial<BridgeReply>[] = [{ phase: 'transcribing' }, { phase: 'error', error: 'helper-failed' }];
    replies['dictation.wait'] = () => answers.shift() ?? { phase: 'done', text: 'again' };
    const lines: string[] = [];
    const texts: string[] = [];
    const d = createDictation({ call, onState: () => {}, onText: (t) => texts.push(t), log: (l) => lines.push(l) });
    d.toggle('en');
    await vi.advanceTimersByTimeAsync(0);
    expect(d.state()).toBe('error');
    expect(lines).toEqual(['dictation: helper-failed']);
    d.toggle('en'); // at once, while the error shows
    await vi.advanceTimersByTimeAsync(0);
    expect(texts).toEqual(['again']);
    expect(d.state()).toBe('idle');
    expect(calls.filter(([op]) => op === 'dictation.start')).toHaveLength(2);
  });

  it('a press while recognizing gives up on it; so does the page after MAX_SESSION_MS', async () => {
    const { calls, replies, call } = fake();
    replies['dictation.wait'] = () => ({ phase: 'transcribing' });
    let held = false;
    const slow = async (op: string, args: Record<string, unknown> = {}) => {
      if (op === 'dictation.wait' && held)
        return new Promise<BridgeReply>((resolve) =>
          setTimeout(() => resolve({ id: 0, ok: false, error: 'timeout' }), 20_000),
        );
      held = op === 'dictation.wait' || held;
      return call(op, args);
    };
    const d = createDictation({ call: slow, onState: () => {}, onText: () => {}, log: () => {} });
    d.toggle('en');
    await vi.advanceTimersByTimeAsync(0);
    expect(d.state()).toBe('transcribing');
    d.toggle('en');
    expect(d.state()).toBe('idle');
    expect(calls.at(-1)![0]).toBe('dictation.cancel');
    d.toggle('en');
    await vi.advanceTimersByTimeAsync(0);
    expect(d.state()).toBe('listening'); // a new session; this one never answers
    await vi.advanceTimersByTimeAsync(MAX_SESSION_MS + 11_000); // the first wait past it ends at 160 s
    expect(d.state()).toBe('error');
    expect(calls.at(-1)![0]).toBe('dictation.cancel');
    await vi.advanceTimersByTimeAsync(ERROR_MS);
    expect(d.state()).toBe('idle');
  });

  it('a wait that times out on the page is asked again', async () => {
    const { calls, replies, call } = fake();
    const answers: Partial<BridgeReply>[] = [
      { ok: false, error: 'timeout' },
      { phase: 'done', text: 'ok' },
    ];
    replies['dictation.wait'] = () => answers.shift()!;
    const texts: string[] = [];
    const d = createDictation({ call, onState: () => {}, onText: (t) => texts.push(t), log: () => {} });
    d.toggle('ja');
    await vi.advanceTimersByTimeAsync(0);
    expect(texts).toEqual(['ok']);
    expect(calls.filter(([op]) => op === 'dictation.wait')).toHaveLength(2);
    expect(d.state()).toBe('idle');
  });
});

describe('dictation on the page', () => {
  it('is off by default: no mic on the toolbar, until it is turned on in Settings → Dictation', async () => {
    const { popup, sidecar } = setup();
    const toolbar = () => [...shadowOf(popup).querySelectorAll<HTMLElement>('.bar .key')].map((k) => k.dataset['k']);
    expect(toolbar()).toEqual(['settings', 'emoji', 'copy', 'cut', 'paste', 'menu', 'hide']); // no gap for it
    expect(sidecar.ops()).toEqual([]);
    await openTab(popup);
    expect(row(popup, 'Engine')).toBeUndefined();
    await flipDictation(popup);
    await closePanel(popup);
    expect(toolbar()).toEqual(['settings', 'emoji', 'dictate', 'copy', 'cut', 'paste', 'menu', 'hide']);
    await openTab(popup);
    await flipDictation(popup);
    await closePanel(popup);
    expect(toolbar()).not.toContain('dictate'); // and gone again when turned off
  });

  it('English: the mic shows each phase, and the phrase is typed after the word, spaced, with no modifier left', async () => {
    const { popup, sidecar, typed } = setup({ dictation: true });
    await tap(popup, 'h');
    await tap(popup, 'i');
    await tap(popup, 'dictate');
    expect(sidecar.asked.find((r) => r.op === 'dictation.start')).toMatchObject({ language: 'en' });
    expect(mic(popup)).toEqual(['listening']);
    await tap(popup, 'shift'); // armed while listening
    await sidecar.phase({ phase: 'transcribing' });
    expect(mic(popup)).toEqual(['recognizing']);
    await sidecar.phase({ phase: 'done', text: 'Hello world.' });
    expect(mic(popup)).toEqual([]);
    expect(typed()).toBe('hi Hello world. ');
    expect(key(popup, 'shift').classList.contains('on')).toBe(false);
    expect(logged.join('\n')).not.toContain('Hello');
  });

  it('pressing the mic again stops listening; switching keyboards cancels', async () => {
    const { popup, sidecar } = setup({ dictation: true });
    await tap(popup, 'dictate');
    await tap(popup, 'dictate');
    expect(sidecar.asked.find((r) => r.op === 'dictation.stop')).toMatchObject({ session: 1 });
    await tap(popup, 'next-keyboard');
    expect(sidecar.ops()).toContain('dictation.cancel');
    expect(mic(popup)).toEqual([]);
  });

  it('a failure shows on the mic for a moment, logged by its code', async () => {
    const { popup, sidecar } = setup({ dictation: true });
    await tap(popup, 'dictate');
    await sidecar.phase({ phase: 'transcribing' });
    await sidecar.phase({ phase: 'error', error: 'helper-failed' });
    expect(mic(popup)).toEqual(['err']);
    expect(logged).toContain('[polykey] dictation: helper-failed');
    await vi.advanceTimersByTimeAsync(ERROR_MS);
    expect(mic(popup)).toEqual([]);
    await tap(popup, 'dictate'); // takes a new press
    expect(sidecar.ops().filter((op) => op === 'dictation.start')).toHaveLength(2);
    expect(mic(popup)).toEqual(['listening']);
  });

  it('Japanese: dictated text goes into the reading for conversion; 確定 sends it', async () => {
    const { popup, api, sidecar, typed } = setup({ dictation: true });
    api.debug.use('ja/12key');
    await tap(popup, 'あ');
    await tap(popup, 'dictate');
    expect(sidecar.asked.find((r) => r.op === 'dictation.start')).toMatchObject({ language: 'ja' });
    await sidecar.phase({ phase: 'done', text: '今日は晴れ' });
    expect(pre(popup)).toBe('あ今日は晴れ');
    expect(typed()).toBe('');
    await tap(popup, 'Enter');
    expect(typed()).toBe('あ今日は晴れ');
  });

  it("where dictated Japanese goes is each reading keyboard's own option, shown while dictation is on", async () => {
    const { popup, api, sidecar } = setup({ dictation: true });
    const dictationRow = () => row(popup, 'Dictation');
    await tap(popup, 'settings');
    expect(dictationRow()).toBeUndefined(); // English: no reading, no option
    await closePanel(popup);
    api.debug.use('ja/jis');
    await tap(popup, 'settings');
    const choices = () => [...dictationRow()!.querySelectorAll<HTMLElement>('.opt')];
    expect(choices().map((o) => [o.textContent, o.classList.contains('on')])).toEqual([
      ['Candidates', true],
      ['Type at once', false],
    ]);
    await touch(choices()[1]!);
    expect(sidecar.asked.filter((r) => r.op === 'settings.save').at(-1)).toMatchObject({
      settings: { keyboardOptions: { 'ja/jis': { dictationCommit: true } } },
    });
  });

  it('Japanese, typed at once: the reading is sent first, then the text', async () => {
    const { popup, api, sidecar, typed } = setup({
      dictation: true,
      keyboardOptions: { 'ja/12key': { dictationCommit: true } },
    });
    api.debug.use('ja/12key');
    await tap(popup, 'あ');
    await tap(popup, 'dictate');
    await sidecar.phase({ phase: 'done', text: '今日は晴れ' });
    expect(pre(popup)).toBeNull();
    expect(typed()).toBe('あ今日は晴れ');
  });

  it('英数 mode on a Japanese keyboard dictates English after the English word', async () => {
    const { popup, api, sidecar, typed } = setup({ dictation: true });
    api.debug.use('ja/jis');
    await tap(popup, 'eisu');
    await tap(popup, 'a');
    await tap(popup, 'dictate');
    expect(sidecar.asked.find((r) => r.op === 'dictation.start')).toMatchObject({ language: 'en' });
    await sidecar.phase({ phase: 'done', text: 'Hi.' });
    expect(typed()).toBe('a Hi. ');
  });

  it('while listening, the speech level moves the bars; recognizing shows the ring', async () => {
    const { popup, sidecar } = setup({ dictation: true });
    await tap(popup, 'dictate');
    const bars = () =>
      [...key(popup, 'dictate').querySelectorAll<HTMLElement>('.mic-bars i')].map((i) => i.style.transform);
    expect(sidecar.asked.filter((r) => r.op === 'dictation.wait').at(-1)).toMatchObject({
      phase: 'listening',
      seq: -1,
    });
    await sidecar.phase({ phase: 'listening', seq: 3, bars: [0, 0, 2, 8, 4] });
    expect(bars()).toEqual(['scaleY(0.140)', 'scaleY(0.140)', 'scaleY(0.355)', 'scaleY(1.000)', 'scaleY(0.570)']);
    expect(sidecar.asked.filter((r) => r.op === 'dictation.wait').at(-1)).toMatchObject({ phase: 'listening', seq: 3 });
    await sidecar.phase({ phase: 'transcribing' });
    expect(mic(popup)).toEqual(['recognizing']);
    expect(bars().every((t) => t === 'scaleY(0.140)')).toBe(true); // flat for next time
    expect(sidecar.asked.filter((r) => r.op === 'dictation.wait').at(-1)).toMatchObject({
      phase: 'transcribing',
      seq: 3,
    });
  });

  it('continuous: each phrase is typed as it comes, joined by the space rule, until the mic stops it', async () => {
    const { popup, sidecar, typed } = setup({ dictation: true, dictationContinuous: true });
    await tap(popup, 'dictate');
    expect(sidecar.asked.find((r) => r.op === 'dictation.start')).toMatchObject({ language: 'en', continuous: true });
    await sidecar.phase({ phase: 'listening', seq: 1, texts: [' Hello there. '], recognizing: false });
    expect(typed()).toBe('Hello there.');
    await sidecar.phase({ phase: 'listening', seq: 2, recognizing: true });
    expect(mic(popup)).toEqual(['listening', 'recognizing']); // bars inside, the arc around
    await sidecar.phase({ phase: 'listening', seq: 3, texts: ['How are you?', '今日は'], recognizing: false });
    expect(typed()).toBe('Hello there. How are you?今日は');
    expect(mic(popup)).toEqual(['listening']);
    await tap(popup, 'dictate'); // stops; what was said is still typed
    expect(sidecar.ops().filter((op) => op === 'dictation.stop')).toHaveLength(1);
    await sidecar.phase({ phase: 'done', texts: ['Fine.'] });
    expect(typed()).toBe('Hello there. How are you?今日はFine. '); // a space after the last, for the next word
    expect(mic(popup)).toEqual([]);
    expect(logged.join('\n')).not.toContain('Hello');
  });

  it('a phrase that comes while a word is swiped follows it, and ends its alternatives', async () => {
    const { popup, sidecar, typed } = setup({
      dictation: true,
      dictationContinuous: true,
      keyboardOptions: { 'en/english': { swipe: true } },
    });
    // jsdom draws nothing: the keys on a grid of 40×30 px cells, and a swipe from one letter's centre to another's.
    [...shadowOf(popup).querySelectorAll('.row')].forEach((row, r) =>
      [...row.querySelectorAll<HTMLElement>('.key')].forEach((el, c) => {
        el.getBoundingClientRect = () =>
          ({ left: c * 40, right: c * 40 + 40, top: r * 30, bottom: r * 30 + 30, width: 40, height: 30 }) as DOMRect;
      }),
    );
    const at = (el: Element, type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
      el.dispatchEvent(e);
    };
    const swipe = async (from: string, to: string) => {
      const centre = (id: string) => {
        const r = key(popup, id).getBoundingClientRect();
        return { x: r.left + 20, y: r.top + 15 };
      };
      const [a, b] = [centre(from), centre(to)];
      at(key(popup, from), 'touchstart', a.x, a.y);
      for (let i = 1; i <= 10; i++)
        at(key(popup, from), 'touchmove', a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
      at(key(popup, from), 'touchend', b.x, b.y);
      await vi.advanceTimersByTimeAsync(20);
    };
    const slots = () => [...shadowOf(popup).querySelectorAll<HTMLElement>('.sugg')].map((el) => el.textContent);
    await tap(popup, 'dictate');
    await sidecar.phase({ phase: 'listening', seq: 1, texts: ['Hello there.'] });
    await swipe('h', 'o');
    await sidecar.phase({ phase: 'listening', seq: 2, texts: ['How are you?'] }); // while the swipe decodes
    expect(typed()).toBe('Hello there.');
    await sidecar.swiped(['hello', 'help']);
    expect(typed()).toBe('Hello there. hello How are you?');
    expect(slots()).toEqual(['', '', '']); // the alternatives would replace the wrong text now
  });

  it('continuous on a Japanese keyboard: phrases go into the reading, one after the other', async () => {
    const { popup, api, sidecar, typed } = setup({ dictation: true, dictationContinuous: true });
    api.debug.use('ja/12key');
    await tap(popup, 'dictate');
    await sidecar.phase({ phase: 'listening', seq: 1, texts: ['今日は'] });
    await sidecar.phase({ phase: 'listening', seq: 2, texts: ['晴れ'] });
    expect(pre(popup)).toBe('今日は晴れ');
    await tap(popup, 'dictate');
    await sidecar.phase({ phase: 'done' });
    expect(typed()).toBe(''); // still the reading, for conversion; no space
    expect(pre(popup)).toBe('今日は晴れ');
  });

  it('no model for the language: the mic opens the Dictation tab there', async () => {
    const { popup, sidecar, api } = setup({ dictation: true });
    api.debug.use('ja/12key');
    sidecar.failStart('no-model');
    await tap(popup, 'dictate');
    expect(shadowOf(popup).querySelector('.panel .opt.tab.on')!.textContent).toBe('Dictation');
    expect(shadowOf(popup).querySelector('.dm .langs .item.sel')!.textContent).toContain('日本語');
    expect(shadowOf(popup).querySelector('.dm .models .note')!.textContent).toBe(
      'No 日本語 model downloaded yet: tap one.',
    );
  });

  it('while the engine downloads the mic is disabled, with the progress along its foot', async () => {
    const { popup, sidecar } = setup(
      { dictation: true },
      { engine: { state: 'downloading', done: 9_000_000, total: 18_000_000 } },
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(mic(popup)).toEqual(['fetching']);
    expect(key(popup, 'dictate').querySelector<HTMLElement>('.mic-track i')!.style.transform).toBe('scaleX(0.500)');
    await tap(popup, 'dictate');
    expect(sidecar.ops()).not.toContain('dictation.start');
    expect(sidecar.holding()).toBe(true); // the page waits for the next change, it does not poll
    await sidecar.change({ engine: ready });
    expect(mic(popup)).toEqual([]);
    expect(sidecar.holding()).toBe(false); // nothing downloads: no more requests
    await tap(popup, 'dictate');
    expect(sidecar.ops()).toContain('dictation.start');
  });
});

describe('settings → Dictation', () => {
  const items = (popup: FakePopupWindow, col: string) => [
    ...panel(popup).querySelectorAll<HTMLElement>(`.dm .${col} .item`),
  ];
  const open = openTab;

  it('the switch turns it on, which fetches the engine', async () => {
    const { popup, sidecar } = setup({}, { engine: { state: 'downloading', done: 0, total: 18_000_000 } });
    await openTab(popup);
    expect(panel(popup).textContent).toContain('nothing is logged or saved');
    await flipDictation(popup);
    expect(sidecar.asked.find((r) => r.op === 'settings.save')).toMatchObject({ settings: { dictation: true } });
    await vi.advanceTimersByTimeAsync(20);
    expect(sidecar.ops()).toContain('dictation.catalog');
    expect(row(popup, 'Engine')!.querySelector('.note')!.textContent).toBe('Downloading the speech engine: 0%');
    await sidecar.change({ engine: { state: 'downloading', done: 9_000_000, total: 18_000_000 } });
    expect(row(popup, 'Engine')!.querySelector('.note')!.textContent).toBe('Downloading the speech engine: 50%'); // in place
  });

  it('languages left, their models in the middle; a tapped model is chosen and downloaded; ✕ deletes', async () => {
    const { popup, sidecar } = setup({ dictation: true });
    await open(popup);
    await vi.advanceTimersByTimeAsync(20);
    expect(items(popup, 'langs').map((i) => i.textContent)).toEqual(['English✓', '日本語', 'Downloaded1']);
    expect(items(popup, 'langs')[0]!.classList.contains('sel')).toBe(true); // the keyboard's
    const models = () => items(popup, 'models');
    // The title line, outside the scroller, labels the grid's columns: the graded language, speed and size.
    const head = () => [...panel(popup).querySelectorAll('.dm .models .sect.colhead > div')].map((d) => d.textContent);
    expect(head()).toEqual(['English models', 'EN', 'Speed', 'Size']);
    expect(models().map((i) => i.querySelector('.nm')!.textContent)).toEqual([
      'Parakeet',
      'SenseVoice Small',
      'Whisper small',
    ]);
    expect(models()[0]!.querySelector('.mark')!.textContent).toBe('✓ in use');
    // Handy's ratings: English error 4.1 % is A−; 30 s of speech in 2.1 s earns three of four bars.
    expect(models()[0]!.querySelector('.grade')!.textContent).toBe('A−');
    expect(models()[0]!.querySelectorAll('.speed rect:not([opacity])')).toHaveLength(3);
    expect(models()[2]!.querySelector('.mark')!.textContent).toBe('270 MB');
    // ✕ ends every row (an empty one where there is nothing to delete), ⓘ just before it.
    expect(models().map((i) => [i.lastElementChild!.className, i.children[4]!.className])).toEqual([
      ['x', 'ic i'],
      ['x', 'ic i'],
      ['x', 'ic i'],
    ]);
    expect(models()[0]!.querySelector('.x svg')).not.toBeNull();
    expect(models()[1]!.querySelector('.x svg')).toBeNull();
    await touch(items(popup, 'langs')[1]!); // 日本語
    expect(head()).toEqual(['日本語 models', 'JA', 'Speed', 'Size']);
    expect(models().map((i) => i.querySelector('.nm')!.textContent)).toEqual(['SenseVoice Small', 'Whisper small']);
    await touch(models()[0]!);
    expect(sidecar.asked.filter((r) => r.op === 'settings.save').at(-1)).toMatchObject({
      settings: { dictationModels: { ja: 'sensevoice' } },
    });
    expect(sidecar.asked.filter((r) => r.op === 'dictation.download').at(-1)).toMatchObject({ model: 'sensevoice' });
    await touch(items(popup, 'langs')[0]!);
    await touch(models()[0]!.querySelector<HTMLElement>('.x')!); // delete Parakeet, not choose it
    expect(sidecar.asked.filter((r) => r.op === 'dictation.delete').at(-1)).toMatchObject({ model: 'parakeet' });
    expect(sidecar.asked.filter((r) => r.op === 'dictation.download')).toHaveLength(1);
  });

  it("ⓘ shows a model's details while hovered, or after a tap until the next one", async () => {
    const { popup, sidecar } = setup({ dictation: true });
    await open(popup);
    await vi.advanceTimersByTimeAsync(20);
    const icon = items(popup, 'models')[0]!.querySelector<HTMLElement>('.ic.i')!;
    const pop = () => panel(popup).querySelector('.dm-pop');
    icon.dispatchEvent(new Event('mouseover', { bubbles: true }));
    const lines = () => [...pop()!.children].map((c) => c.textContent);
    expect(lines()).toEqual([
      'Parakeet',
      'English · 730 MB · ~1 GB RAM',
      'English.',
      'CC BY 4.0 · NVIDIA · 8-bit GGUF by handy-computer',
      'Handy, not the Frame: 30 s in 2.1 s · EN error 4.1%',
    ]);
    items(popup, 'langs')[0]!.dispatchEvent(new Event('mouseover', { bubbles: true }));
    expect(pop()).toBeNull();
    await touch(icon); // touch has no hover: a tap opens it
    expect(pop()).not.toBeNull();
    expect(sidecar.ops()).not.toContain('settings.save'); // not a tap on the row
    items(popup, 'langs')[0]!.dispatchEvent(new Event('mouseover', { bubbles: true }));
    expect(pop()).not.toBeNull(); // stays while tapped open
    await touch(panel(popup).querySelector<HTMLElement>('.dm .row.engine .note')!);
    expect(pop()).toBeNull(); // a tap elsewhere closes it
    const engineInfo = panel(popup).querySelector<HTMLElement>('.dm .row.engine .ic.i')!;
    engineInfo.dispatchEvent(new Event('mouseover', { bubbles: true }));
    expect(pop()!.textContent).toContain('transcribe.cpp by its authors (MIT)');
  });

  it('Downloaded lists what is on disk, which of your languages use it, and deletes only by ✕', async () => {
    const { popup, sidecar } = setup(
      { dictation: true },
      {
        models: { 'whisper-small': ready, parakeet: ready, sensevoice: { state: 'downloading', done: 0, total: 200 } },
        choices: { ja: 'whisper-small' },
      },
    );
    await open(popup);
    await vi.advanceTimersByTimeAsync(20);
    const downloaded = items(popup, 'langs').at(-1)!;
    expect(downloaded.closest('.dlsect')).not.toBeNull(); // its own section, outside the languages' scroller
    expect(downloaded.closest('.list')).toBeNull();
    await touch(downloaded);
    const head = [...panel(popup).querySelectorAll('.dm .models .colhead > div')].map((d) => d.textContent);
    expect(head).toEqual(['Downloaded · 999 MB', 'Used for', 'Size']); // the finished ones
    expect(
      items(popup, 'models').map((i) => ['.nm', '.used', '.mark'].map((c) => i.querySelector(c)!.textContent)),
    ).toEqual([
      ['Whisper small', '日本語', '✓'],
      ['Parakeet', 'English', '✓'],
      ['SenseVoice Small', 'not used', '0%'],
    ]);
    expect(items(popup, 'models').every((i) => i.lastElementChild!.querySelector('svg'))).toBe(true); // ✕ on each
    await touch(items(popup, 'models')[0]!); // a row tap chooses nothing
    expect(sidecar.ops()).not.toContain('settings.save');
    await touch(items(popup, 'models')[0]!.querySelector<HTMLElement>('.x')!);
    expect(sidecar.asked.filter((r) => r.op === 'dictation.delete').at(-1)).toMatchObject({ model: 'whisper-small' });
  });

  it("any-language models are in every language's list, graded for it", async () => {
    const { popup } = setup(
      { dictation: true },
      { models: { ...READY.models, 'whisper-small': ready }, choices: { en: 'whisper-small', ja: 'whisper-small' } },
    );
    await open(popup);
    await vi.advanceTimersByTimeAsync(20);
    const whisper = items(popup, 'models').find((i) => i.querySelector('.nm')!.textContent === 'Whisper small')!;
    expect(whisper.querySelector('.mark')!.textContent).toBe('✓ in use');
    expect(whisper.querySelector('.grade')!.textContent).toBe('B'); // graded for English here
    await touch(items(popup, 'langs')[1]!);
    const ja = items(popup, 'models').find((i) => i.querySelector('.nm')!.textContent === 'Whisper small')!;
    expect(ja.querySelector('.grade')!.textContent).toBe('C'); // and for Japanese there
  });

  it('the lists drag-scroll; a drag past the slop selects nothing', async () => {
    const { popup, sidecar } = setup({ dictation: true });
    await open(popup);
    await vi.advanceTimersByTimeAsync(20);
    const list = panel(popup).querySelector<HTMLElement>('.dm .models .list')!;
    const item = items(popup, 'models')[2]!;
    const at = (type: string, y: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'changedTouches', { value: [{ clientX: 100, clientY: y }] });
      item.dispatchEvent(e);
    };
    list.scrollTop = 40;
    at('touchstart', 200);
    at('touchmove', 195); // within the slop: nothing moves
    expect(list.scrollTop).toBe(40);
    at('touchmove', 170);
    expect(list.scrollTop).toBe(70);
    at('touchend', 170);
    await vi.advanceTimersByTimeAsync(50);
    expect(sidecar.ops()).not.toContain('settings.save');
    at('touchstart', 200);
    at('touchend', 203); // a tap
    await vi.advanceTimersByTimeAsync(50);
    expect(sidecar.asked.filter((r) => r.op === 'settings.save').at(-1)).toMatchObject({
      settings: { dictationModels: { en: 'whisper-small' } },
    });
  });

  it('a downloading model shows a bar along its row: a stripe until bytes come, then its share', async () => {
    const { popup, sidecar } = setup(
      { dictation: true },
      { models: { ...READY.models, sensevoice: { state: 'downloading', done: 0, total: 200 } } },
    );
    await open(popup);
    await vi.advanceTimersByTimeAsync(20);
    const bar = () => items(popup, 'models')[1]!.querySelector<HTMLElement>('.dlbar');
    expect(bar()!.classList.contains('wait')).toBe(true);
    await sidecar.change({ models: { ...READY.models, sensevoice: { state: 'downloading', done: 50, total: 200 } } });
    expect(bar()!.classList.contains('wait')).toBe(false);
    expect(bar()!.querySelector('i')!.style.width).toBe('25%');
    expect(items(popup, 'models')[1]!.querySelector('.mark')!.textContent).toBe('25%');
    await sidecar.change({ models: { ...READY.models, sensevoice: ready } });
    expect(bar()).toBeNull();
  });

  it('a failed engine download says why and offers a retry', async () => {
    const { popup, sidecar } = setup({ dictation: true }, { engine: { state: 'missing', error: 'network' } });
    await open(popup);
    await vi.advanceTimersByTimeAsync(20);
    const engine = row(popup, 'Engine')!;
    expect(engine.querySelector('.note')!.textContent).toBe('Engine download failed: no connection');
    const retry = engine.querySelector<HTMLElement>('.opt.dl')!;
    expect(retry.textContent).toBe('Retry');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sidecar.holding()).toBe(false); // a failure is not followed
    await touch(retry);
    expect(sidecar.asked.filter((r) => r.op === 'dictation.download').at(-1)).not.toHaveProperty('model');
  });
});
