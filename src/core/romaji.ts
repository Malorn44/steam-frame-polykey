// Romaji to kana with a table pack (Mozc's romanji-hiragana, BSD-3): each entry is input → kana, with
// letters that stay pending (kk → っ, then k waits). Pure. Letters wait while they could still become
// a longer entry (n could be な); flushRomaji settles what is left (n → ん) before converting or sending.

export type TableEntry = readonly [input: string, output: string, pending?: string];
export interface RomajiTable {
  readonly entries: ReadonlyMap<string, { readonly output: string; readonly pending: string }>;
  /** Every proper prefix of an input: such letters may still become a longer entry. */
  readonly prefixes: ReadonlySet<string>;
}

export const romajiTable = (entries: readonly TableEntry[]): RomajiTable => {
  const map = new Map(entries.map(([input, output, pending]) => [input, { output, pending: pending ?? '' }]));
  const prefixes = new Set<string>();
  for (const input of map.keys()) for (let n = 1; n < input.length; n++) prefixes.add(input.slice(0, n));
  return { entries: map, prefixes };
};

/** Whether a character can be romaji input (printable ASCII); kana and the rest are kept as they are. */
export const isRomaji = (ch: string): boolean => /^[\x21-\x7e]$/.test(ch);

/**
 * Convert typed letters: `out` is settled (kana, or letters no entry can use), `rest` still waits.
 * With `final`, nothing waits: an exact entry is used even if a longer one could follow (n → ん).
 */
export const feedRomaji = (letters: string, table: RomajiTable, final = false): { out: string; rest: string } => {
  let s = letters;
  let out = '';
  for (let guard = 0; s && guard < 64; guard++) {
    // a bad table (pending as long as its input) cannot loop
    const lower = s.toLowerCase() === s;
    if (!final && lower && table.prefixes.has(s)) break; // could still grow into a longer entry
    const exact = lower ? table.entries.get(s) : undefined;
    if (exact) {
      out += exact.output;
      s = exact.pending;
      continue;
    }
    // No entry for all of it: use the longest entry it starts with, else let the first letter through.
    let used = false;
    for (let n = s.length - 1; n > 0; n--) {
      const head = s.slice(0, n);
      const entry = head.toLowerCase() === head ? table.entries.get(head) : undefined;
      if (entry) {
        out += entry.output;
        s = entry.pending + s.slice(n);
        used = true;
        break;
      }
    }
    if (!used) {
      out += s[0];
      s = s.slice(1);
    }
  }
  return s && final ? { out: out + s, rest: '' } : { out, rest: s };
};
