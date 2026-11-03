// A reading in its three kana forms, as 無変換 (Windows) or Ctrl+J/K/; (Mac) give them: ひらがな,
// カタカナ, and half-width ﾊﾝｶｸ. Pure.

export type Form = 'hiragana' | 'katakana' | 'halfwidth';
export const FORMS: readonly Form[] = ['hiragana', 'katakana', 'halfwidth'];
/** What a key that goes to this form shows. */
export const FORM_LABELS: Record<Form, string> = { hiragana: 'かな', katakana: 'カナ', halfwidth: 'ﾊﾝｶｸ' };

export const toKatakana = (text: string): string =>
  text.replace(/[ぁ-ゖゝゞ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));

const FULL = 'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン。「」、・゛゜';
const HALF = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ｡｢｣､･ﾞﾟ';
const HALF_OF = new Map(Array.from(FULL, (ch, i) => [ch, HALF[i]!]));
// Voiced kana come apart (ガ → カ + U+3099) and their marks become ﾞ and ﾟ.
const MARKS = new Map([['゙', 'ﾞ'], ['゚', 'ﾟ']]);

/** Half-width katakana; kana with no half-width form (ヮ, ヵ, ヶ) stay as they are. */
export const toHalfwidth = (text: string): string =>
  Array.from(toKatakana(text), (ch) => {
    const parts = ch.normalize('NFD');
    const base = HALF_OF.get(parts[0]!);
    if (!base) return ch;
    const marks = Array.from(parts.slice(1), (m) => MARKS.get(m));
    return marks.every(Boolean) ? base + marks.join('') : ch;
  }).join('');

export const inForm = (text: string, form: Form): string =>
  (form === 'katakana' ? toKatakana(text) : form === 'halfwidth' ? toHalfwidth(text) : text);

export const nextForm = (form: Form): Form => FORMS[(FORMS.indexOf(form) + 1) % FORMS.length]!;
