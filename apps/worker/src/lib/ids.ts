/** Id helpers. */
export const newId = (): string => crypto.randomUUID();

/** Short join code used for contest matches (was matchHandler.generateJoinId). */
export const generateJoinId = (): string =>
  "JN-" + Math.random().toString(36).substring(2, 8).toUpperCase();

export const now = (): number => Date.now();
