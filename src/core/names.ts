// Names in packs: a plain string, or a map of language codes to names ({"en": "Smiling", "ja": "笑顔"}).

/** A pack's name: one string for every language, or one per language code (en, ja, pt-BR). */
export type PackName = string | Readonly<Record<string, string>>;

/**
 * The name to show in `language`: that code's, then its base language's (pt-BR → pt), then English,
 * then the first there is. A plain string is every language's name.
 */
export const nameFor = (name: PackName, language?: string): string => {
  if (typeof name === 'string') return name;
  const own = (code: string | undefined): string | undefined => (code && Object.hasOwn(name, code) ? name[code] : undefined);
  return own(language) ?? own(language?.split('-')[0]) ?? own('en') ?? Object.values(name)[0] ?? '';
};
