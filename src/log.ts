// Logging for code running inside Steam. The sidecar forwards console lines that start with
// PREFIX to the journal. Never pass typed text, candidates or anything read from a text field.

export const PREFIX = '[polykey]';

export const log = (...parts: unknown[]): void => {
  console.log(PREFIX, ...parts);
};

export const warn = (...parts: unknown[]): void => {
  console.warn(PREFIX, ...parts);
};
