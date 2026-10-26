/**
 * "Not interested" undo on Home: take a battle out of the list, remembering where
 * it was, and put it back in the same place if the user taps Undo. Pure.
 */
export interface RemovedCard {
  item: any;
  index: number;
}

/** The list without `id`, and what is needed to put it back (null if it was not there). */
export function removeCard(list: any[], id: string): { list: any[]; removed: RemovedCard | null } {
  const index = list.findIndex((m) => m?.id === id);
  if (index < 0) return { list, removed: null };
  return { list: [...list.slice(0, index), ...list.slice(index + 1)], removed: { item: list[index], index } };
}

/**
 * Put a removed card back at its old position (clamped to the end), unless the
 * list already has it again (a refresh brought it back first).
 */
export function restoreCard(list: any[], removed: RemovedCard): any[] {
  if (list.some((m) => m?.id === removed.item?.id)) return list;
  const at = Math.min(Math.max(removed.index, 0), list.length);
  return [...list.slice(0, at), removed.item, ...list.slice(at)];
}
