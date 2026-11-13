// The candidate bar of a keyboard with a composer (src/core/composers/): what is being composed waits
// there until it is sent, with the converter's candidates beside it. One controller for every composer:
// it keeps the composer's state, sends its commits as text, asks the converter the keyboard names
// (sidecar/polykey/converters/) and drops stale answers, and says what the bar shows. A key the composer
// does not take sends what waits first, then acts as usual (main.ts). What is composed is typed text:
// never logged.

import type { BridgeReply, Call } from './bridge/client.js';
import type { KeyDef } from './core/catalog.js';
import type {
  Composer, ComposerContext, ComposerInput, ComposerResult, Converted, ConverterRequest, Learned, LiveSource,
} from './core/composers/composer.js';
import type { Effect } from './core/keyboard.js';
import type { CompositionView } from './ui/view.js';

/** The current keyboard as the bar drives it. */
export interface BarKeyboard {
  readonly composer: Composer<unknown>;
  readonly ctx: ComposerContext;
  /** The converter the keyboard names (its `converter`), if any. */
  readonly converter: string | undefined;
}

export interface Bar {
  composing(): boolean;
  /** A press for the composer; false: not for it (the caller sends what waits first, then the key acts). */
  press(key: KeyDef, input: ComposerInput): boolean;
  /** Send what waits (another key, a switch to the Latin mode). */
  flush(): void;
  /** Leaving the keyboard: what waits is sent as it stands, and the bar starts empty. */
  leave(): void;
  /** The field closed: what waits is dropped, not typed elsewhere. */
  drop(): void;
  /** An option changed: anything waiting on the next press (a tap cycle) ends. */
  pause(): void;
  /** A candidate picked in the bar. */
  pick(text: string, index: number): void;
  /** Dictated text into the composition, for its candidates; else sent at once, after what waits. */
  dictate(text: string): void;
  /** What the bar shows of the composition, its key labels as names (convert, confirm); null when nothing is composed. */
  shown(): { composition: CompositionView; labels: Readonly<Record<string, string>> } | null;
  /** The text being composed, as the bar shows it ('' when nothing is): the word being typed, for dictation's spacing. */
  composedText(): string;
}

const segmentsOf = (reply: BridgeReply): Converted[] =>
  (reply.ok && Array.isArray(reply['segments']) ? reply['segments'] as Converted[] : []);

export const createBar = ({ call, available, enqueue, show, warn, keyboard }: {
  call: Call;
  available: () => boolean;
  enqueue: (effects: readonly Effect[]) => void;
  /** Draw the bar again: after a press, and when the converter answers. */
  show: () => void;
  warn: (line: string) => void;
  /** The current keyboard, or null when its keys type at once. */
  keyboard: () => BarKeyboard | null;
}): Bar => {
  /** The composer's state, kept with the composer that made it. */
  let held: { composer: Composer<unknown>; state: unknown } | null = null;
  /** The candidates while typing, and what the converter said they came from (so a pick can be learned). */
  let live: string[] = [];
  let liveSource: LiveSource | null = null;
  /** Each request's number: an answer to an older one is dropped. */
  let generation = 0;
  /** Converters that did not load (each warned about once). */
  const down = new Set<string>();

  const stateOf = (kb: BarKeyboard): unknown => (held?.composer === kb.composer ? held.state : kb.composer.empty);
  const set = (kb: BarKeyboard, state: unknown): void => { held = { composer: kb.composer, state }; };
  const composing = (kb: BarKeyboard | null): kb is BarKeyboard => !!kb && kb.composer.composing(stateOf(kb));

  const note = (converter: string, reply: BridgeReply): void => {
    if (reply.error === 'unavailable' && !down.has(converter)) {
      down.add(converter);
      warn(`conversion unavailable (${converter} did not load); what is typed is still sent as it is`);
    }
  };

  /** Have the converter learn what was sent, so picked candidates come first next time. */
  const learn = (kb: BarKeyboard, learned: Learned): void => {
    if (available() && kb.converter) void call('learn', { converter: kb.converter, ...learned });
  };

  /** Ask the converter for live candidates or a conversion; with none, the candidates are the composer's own. */
  const request = (kb: BarKeyboard, req: ConverterRequest): void => {
    const convert = kb.composer.convert;
    const asked = ++generation;
    const forReading = convert ? convert.reading(stateOf(kb), kb.ctx) : '';
    const converter = kb.converter;
    if (!convert || !forReading || !converter || !available()) {
      live = convert && forReading ? convert.live(forReading, [], []) : [];
      show();
      return;
    }
    if (req.kind === 'live') {
      live = convert.live(forReading, [], []); // the reading itself until the converter answers
      void Promise.all([
        call('convert', { converter, reading: forReading }),
        call('predict', { converter, reading: forReading }),
      ]).then(([converted, predicted]) => {
        note(converter, converted);
        if (asked !== generation) return;
        const predictions = predicted.ok && Array.isArray(predicted['predictions']) ? predicted['predictions'] as string[] : [];
        live = convert.live(forReading, segmentsOf(converted), predictions);
        liveSource = { reading: forReading, segments: segmentsOf(converted), predictions };
        show();
      });
    } else {
      void call('convert', {
        converter,
        reading: forReading,
        ...(req.lengths ? { lengths: req.lengths } : {}),
        ...(req.resize ? { resize: req.resize } : {}),
      }).then((reply) => {
        note(converter, reply);
        if (asked !== generation) return;
        set(kb, convert.converted(stateOf(kb), forReading, segmentsOf(reply)));
        show();
      });
    }
    show();
  };

  const apply = (kb: BarKeyboard, result: ComposerResult<unknown>): void => {
    if (result.learned) learn(kb, result.learned);
    set(kb, result.state);
    if (result.effects.length) enqueue(result.effects);
    if (result.request) request(kb, result.request);
    else show();
  };

  const flush = (): void => {
    const kb = keyboard();
    if (composing(kb)) apply(kb, kb.composer.flush(stateOf(kb), kb.ctx));
  };

  const shown: Bar['shown'] = () => {
    const kb = keyboard();
    if (!composing(kb)) return null;
    const { preedit, labels } = kb.composer.show(stateOf(kb), kb.ctx);
    return { composition: 'segments' in preedit ? preedit : { ...preedit, candidates: live, selected: -1 }, labels };
  };

  /** Forget what is composed; a converter's answer still on its way is dropped. */
  const clear = (): void => {
    held = null;
    live = [];
    generation++;
  };

  return {
    composing: () => composing(keyboard()),
    press: (key, input) => {
      const kb = keyboard();
      const result = kb && kb.composer.press(stateOf(kb), key, input, kb.ctx);
      if (!kb || !result) return false;
      apply(kb, result);
      return true;
    },
    flush,
    leave: () => {
      const kb = keyboard();
      if (composing(kb)) enqueue(kb.composer.flush(stateOf(kb), kb.ctx).effects);
      clear();
    },
    drop: clear,
    pause: () => {
      const kb = keyboard();
      if (kb?.composer.pause) set(kb, kb.composer.pause(stateOf(kb)));
    },
    pick: (text, index) => {
      const kb = keyboard();
      if (kb?.composer.convert) apply(kb, kb.composer.convert.pick(stateOf(kb), text, index, liveSource));
    },
    dictate: (text) => {
      const kb = keyboard();
      const into = kb && !kb.ctx.options.dictationCommit ? kb.composer.insert?.(stateOf(kb), text, kb.ctx) : null;
      if (kb && into) {
        apply(kb, into);
        return;
      }
      flush();
      enqueue([{ kind: 'text', text }]);
    },
    shown,
    composedText: () => {
      const composition = shown()?.composition;
      if (!composition) return '';
      return 'segments' in composition ? composition.segments.join('') : composition.before + composition.after;
    },
  };
};
