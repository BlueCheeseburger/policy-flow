// Sheet naming + cleanup rules shared by every feature that adds tabs to a flow.
//
// THE RULE: when something needs a sheet, it MAKES one. It never hunts for an
// unused default tab to rename. Then, once the whole operation is finished, any
// sheet that is still carrying a default name AND has nothing in it is dropped.
//
// This replaced Auto Flow's old "find an empty placeholder and rename it into
// place" pass, which had two problems. It quietly repurposed slots the user may
// have been holding for something, and it made tab ORDER depend on which
// placeholder happened to be free rather than on the order positions actually
// came up in the doc. Creating and then cleaning up is the same end result with
// neither of those failure modes, and it's a rule any future feature can follow
// without knowing anything about the default layouts.
//
// Run the tests:  npx tsx scripts/test-flow-sheet-naming.ts

/**
 * A sheet name the app generated, not one anybody chose.
 *
 * - `Adv 1` / `Advantage 2` / `Contention 3` — aff case slots in the default layouts
 * - `Off 1` … `Off 4`                        — neg off-case slots
 * - `Sheet 2`                                — FlowView's "+" button default
 *
 * Anything else — "Politics DA", "Case", "RFD/Notes", "Turns", "Solvency" — is a
 * real name and is never treated as disposable, even when the sheet is empty.
 * That's deliberate: an empty tab called "Politics DA" is telling you the
 * position existed but nothing landed on it, which is information worth keeping.
 */
export const PLACEHOLDER_SHEET_RE = /^(off|adv|advantage|contention|sheet)\s*\d+$/i;

export function isPlaceholderSheetName(name: string): boolean {
  return PLACEHOLDER_SHEET_RE.test(String(name ?? '').trim());
}

/** True when no cell on the sheet has any non-whitespace content. */
export function isSheetEmpty(sheet: { cells?: Record<string, string> }): boolean {
  const cells = sheet?.cells ?? {};
  for (const k in cells) {
    if (String(cells[k] ?? '').trim()) return false;
  }
  return true;
}

/**
 * Drop every still-default, still-empty sheet. Call this ONCE, after all writing
 * is done — never mid-operation, or a tab that was about to be written to would
 * disappear out from under the writer.
 *
 * Never returns an empty array: a flow always has at least one sheet, so if
 * everything qualifies (an Auto Flow run where every single card was skipped)
 * the original list is handed back untouched rather than leaving a flow with no
 * tabs at all.
 */
export function pruneUnnamedEmptySheets<T extends { name: string; cells?: Record<string, string> }>(
  sheets: T[],
): T[] {
  const kept = (sheets ?? []).filter((s) => !(isPlaceholderSheetName(s.name) && isSheetEmpty(s)));
  return kept.length > 0 ? kept : sheets;
}
