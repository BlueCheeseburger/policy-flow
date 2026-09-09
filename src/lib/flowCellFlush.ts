/**
 * Merging the flow editor's live cell buffer back into its sheets.
 *
 * FlowView keeps the sheet being edited in a mutable ref (`cellsRef`) rather
 * than in React state, so typing doesn't re-render the whole grid on every
 * keystroke. That buffer has to be merged back into the sheets array on every
 * save, tab switch, undo snapshot, and persist.
 *
 * It used to be merged by INDEX (`sheets[activeSheetIdx]`), which silently
 * corrupted data: `activeSheetIdx` (React state) and `snap.current` only resync
 * in a post-render effect, so any flush that landed in that window — an async
 * AI-summary write, a debounced save, anything after a tab switch or a
 * drag-reorder that shifted indices — wrote the CURRENT tab's cells into a
 * DIFFERENT tab's slot. To the user that looked like arguments teleporting
 * between tabs mid-round.
 *
 * Merging by the buffer's OWNER SHEET ID makes that class of bug unwritable: if
 * the owner isn't in the list (deleted, or state is mid-transition), the buffer
 * is dropped rather than misfiled. Losing an unsaved keystroke is recoverable;
 * writing it onto the wrong argument is not.
 */

export interface FlushableSheet {
  id: string;
  cells: Record<string, string>;
}

export function flushCellsIntoSheets<T extends FlushableSheet>(
  sheets: T[],
  ownerId: string | null,
  cells: Record<string, string>,
): T[] {
  if (!ownerId) return sheets;
  if (!sheets.some((sh) => sh.id === ownerId)) return sheets; // owner gone — drop, never misfile
  return sheets.map((sh) => (sh.id === ownerId ? { ...sh, cells: { ...cells } } : sh));
}
