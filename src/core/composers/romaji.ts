// The romaji composer: the kana composer's reading buffer, with typed letters always going through the
// keyboard's romaji table (ka → か).

import { readingComposer } from './kana.js';

export const romaji = readingComposer(() => true);
