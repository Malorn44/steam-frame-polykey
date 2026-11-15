// The candidate bar of a keyboard with a composer (src/core/composers/): what is being composed waits
// there until it is sent, with the converter's candidates beside it. One controller for every composer:
// it keeps the composer's state, sends its commits as text, asks the converter the keyboard names
// (sidecar/polykey/converters/) and drops stale answers, and says what the bar shows. A key the composer
// does not take sends what waits first, then acts as usual (main.ts).
//
// A composer that can (its `inline`) composes in the text field instead, where the caller says retyping
// is safe: each change deletes the end of the tail that differs and types the rest (core/output/inline.ts),
// and the bar shows only candidates. The tail is only ever what this controller typed of the composition.
// It is forgotten without a Backspace whenever the field may have changed (lose), and typing into another
// target than it was typed into first forgets it too; sends queued before that are skipped. A
// composition that may no longer be retyped (Desktop Mode) stays in the field as it is. What is composed,
// the tail included, is typed text: never logged.

import type { BridgeReply, Call } from './bridge/client.js';
import type { KeyDef } from './core/catalog.js';
import type {
  Composer, ComposerContext, ComposerInput, ComposerResult, Converted, ConverterRequest, Learned, LiveSource,
} from './core/composers/composer.js';
import type { Effect } from './core/keyboard.js';
import { retype as retypeStep } from './core/output/inline.js';
import type { CompositionView } from './ui/view.js';

/** The current keyboard as the bar drives it. */
export interface BarKeyboard {
  readonly composer: Composer<unknown>;
  readonly ctx: ComposerContext;
  /** The converter the keyboard names (its `converter`), if any. */
  readonly converter: string | undefined;
}

/** A send of the composition into the field: made only while `live` (the field still holds what it was planned against). */
export interface InlineSend { readonly live: () => boolean }

export interface Bar {
  composing(): boolean;
  /** A press for the composer; false: not for it (the caller sends what waits first, then the key acts). */
  press(key: KeyDef, input: ComposerInput): boolean;
  /** Send what waits (another key, a switch to the Latin mode). */
  flush(): void;
  /** Leaving the keyboard: what waits is sent as it stands, and the bar starts empty. */
  leave(): void;
  /**
   * Drop what waits, never sent: the field closed (it would be typed elsewhere), or a picked word
   * replaces it. What is already in the field stays there.
   */
  drop(): void;
  /**
   * The field may have changed (another field, a moved caret, a send that failed): what of the
   * composition is in the field is forgotten, without a Backspace, and sends of it still queued are
   * skipped. A composition waiting in the bar stays.
   */
  lose(): void;
  /** Whether part of the composition is in the text field now (it is retyped as it changes). */
  inField(): boolean;
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

export const createBar = ({ call, available, enqueue, show, warn, keyboard, retype = () => false, target = () => '' }: {
  call: Call;
  available: () => boolean;
  /** Send effects in order; a send into the field carries `inline`, and is skipped once it is no longer live. */
  enqueue: (effects: readonly Effect[], inline?: InlineSend) => void;
  /** Draw the bar again: after a press, and when the converter answers. */
  show: () => void;
  warn: (line: string) => void;
  /** The current keyboard, or null when its keys type at once. */
  keyboard: () => BarKeyboard | null;
  /** Whether a composer that can compose in the field does so now (the target and the setting allow it). */
  retype?: () => boolean;
  /** Where typing goes now (the field's target, '' while closed): what is in the field belongs to one. */
  target?: () => string;
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
  /** What of the composition is in the field, as it stands once the sends queued are made, and the target it went to. */
  let tail = '';
  let tailTarget = '';
  /** Bumped when the field may no longer hold the tail: sends into it queued before are skipped. */
  let epoch = 0;

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

  const retyping = (kb: BarKeyboard): boolean => kb.composer.inline === true && retype();

  /** Send what the composer sends: as it is, or into the field, against the tail typed so far. */
  const send = (kb: BarKeyboard, effects: readonly Effect[]): void => {
    if (!retyping(kb)) {
      if (effects.length) enqueue(effects);
      return;
    }
    const { preedit } = kb.composer.show(stateOf(kb), kb.ctx);
    const step = retypeStep(tail, effects, 'segments' in preedit ? null : preedit.before + preedit.after);
    tail = step.tail;
    tailTarget = target();
    const planned = epoch;
    if (step.effects.length) enqueue(step.effects, { live: () => planned === epoch });
  };

  /** Forget what is composed; a converter's answer still on its way is dropped. What is in the field stays. */
  const clear = (): void => {
    held = null;
    live = [];
    tail = '';
    generation++;
  };

  const lose = (): void => {
    epoch++;
    if (tail) clear();
  };

  /**
   * Before acting: forget what is in the field when typing goes elsewhere now; when it may no longer be
   * retyped there (Desktop Mode, the setting, another keyboard), it stays as it is and the composer starts afresh.
   */
  const settle = (kb: BarKeyboard | null): void => {
    if (!tail) return;
    if (target() !== tailTarget) lose();
    else if (!kb || held?.composer !== kb.composer || !retyping(kb)) clear();
  };

  const apply = (kb: BarKeyboard, result: ComposerResult<unknown>): void => {
    if (result.learned) learn(kb, result.learned);
    set(kb, result.state);
    send(kb, result.effects);
    if (result.request) request(kb, result.request);
    else show();
  };

  const flush = (): void => {
    const kb = keyboard();
    settle(kb);
    if (composing(kb)) apply(kb, kb.composer.flush(stateOf(kb), kb.ctx));
  };

  const shown: Bar['shown'] = () => {
    const kb = keyboard();
    if (!composing(kb)) return null;
    const { preedit, labels } = kb.composer.show(stateOf(kb), kb.ctx);
    if ('segments' in preedit) return { composition: preedit, labels };
    // In the field: the bar shows only the candidates.
    return { composition: tail ? { before: '', after: '', candidates: live, selected: -1 } : { ...preedit, candidates: live, selected: -1 }, labels };
  };

  return {
    composing: () => composing(keyboard()),
    press: (key, input) => {
      const kb = keyboard();
      settle(kb);
      const result = kb && kb.composer.press(stateOf(kb), key, input, kb.ctx);
      if (!kb || !result) return false;
      apply(kb, result);
      return true;
    },
    flush,
    leave: () => {
      const kb = keyboard();
      settle(kb);
      if (composing(kb)) {
        const flushed = kb.composer.flush(stateOf(kb), kb.ctx);
        set(kb, flushed.state);
        send(kb, flushed.effects);
      }
      clear();
    },
    drop: clear,
    lose,
    inField: () => tail !== '',
    pause: () => {
      const kb = keyboard();
      if (kb?.composer.pause) set(kb, kb.composer.pause(stateOf(kb)));
    },
    pick: (text, index) => {
      const kb = keyboard();
      settle(kb);
      if (kb?.composer.convert) apply(kb, kb.composer.convert.pick(stateOf(kb), text, index, liveSource));
    },
    dictate: (text) => {
      const kb = keyboard();
      settle(kb);
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
