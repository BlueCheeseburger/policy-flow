// "You're naming a stock issue — want the stock-issues layout?"
//
// New policy flows default to the ADVANTAGE layout (Adv 1/2/3 + Off 1–4), because
// nearly every modern policy aff is an advantage aff. A stock-issues aff is the
// minority case, and the old cost of it was renaming three tabs by hand.
//
// So: watch what the user types into a tab rename. The moment it looks like a
// stock issue, offer to convert the whole flow — rename the still-default
// advantage tabs to Inherency / Harms / Solvency in one click.
//
// Everything here is pure so scripts/test-stock-issue-suggest.ts can exercise it
// without React. FlowView.tsx owns the UI and the dismissal.

/** Canonical order. This is also the order the stock-issues layout ships in. */
export const STOCK_ISSUES = ['Inherency', 'Harms', 'Solvency'];

/**
 * A tab still carrying its layout-default name. Only these are ever renamed by a
 * conversion — a tab the user named themselves is theirs, and silently
 * overwriting it would be the same class of bug as a shortcut that rebinds
 * without asking.
 */
const DEFAULT_ADVANTAGE_TAB = /^(adv|advantage|contention)\s*\d+$/i;

export function isDefaultAdvantageTab(name: string): boolean {
  return DEFAULT_ADVANTAGE_TAB.test(String(name ?? '').trim());
}

/**
 * Which stock issue the user appears to be typing, or null.
 *
 * Three characters minimum ("inh", "har", "sol"); one or two letters would fire
 * on almost anything. The typed text must be a prefix OF the stock issue, not the
 * other way round — so "Solvency" matches and "Solvency Deficit" (an ordinary
 * advantage-flow tab) stops matching the moment it grows past the word.
 *
 * "Solvency" is the weak signal of the three: an advantage aff has a solvency
 * contention too, which is exactly why `inferVariantFromHats` refuses to treat it
 * as a layout signal. It is included here anyway because this only ever SUGGESTS
 * — and FlowView remembers a dismissal, so a false positive costs one click,
 * once, per flow.
 */
export function matchStockIssue(typed: string): string | null {
  const t = String(typed ?? '').trim().toLowerCase();
  if (t.length < 3) return null;
  return STOCK_ISSUES.find((s) => s.toLowerCase().startsWith(t)) ?? null;
}

export interface StockIssuePlan {
  /** The stock issue the typed text matched. */
  matched: string;
  /** Full replacement name list, same length/order as the input. */
  names: string[];
  /** The tabs this would rename, for showing the user before they accept. */
  renames: { from: string; to: string }[];
}

/**
 * What converting would actually do — or null when it isn't worth offering.
 *
 * The tab being renamed keeps the stock issue the user typed, in place. The
 * OTHER still-default advantage tabs take the remaining stock issues in
 * canonical order. Assigning all three positionally instead would override what
 * the user just typed (type "Harms" into Adv 1, get "Inherency"), and the point
 * of the suggestion is to save typing, not to argue with it.
 *
 * Returns null when there is no other default tab to fill, since then the
 * conversion would rename exactly the one tab the user is already renaming and
 * save them nothing.
 */
export function planStockIssueConversion(
  sheetNames: string[],
  renamingIdx: number,
  typed: string,
): StockIssuePlan | null {
  const names = [...(sheetNames ?? [])];
  const matched = matchStockIssue(typed);
  if (!matched) return null;
  if (renamingIdx < 0 || renamingIdx >= names.length) return null;
  if (!isDefaultAdvantageTab(names[renamingIdx])) return null;

  const others = names
    .map((n, i) => ({ n, i }))
    .filter(({ n, i }) => i !== renamingIdx && isDefaultAdvantageTab(n));
  if (others.length === 0) return null;

  // Never create a duplicate tab name: a stock issue already on the flow is
  // dropped from the fill list rather than written a second time.
  const taken = new Set(names.map((n) => n.trim().toLowerCase()));
  const remaining = STOCK_ISSUES.filter(
    (s) => s !== matched && !taken.has(s.toLowerCase()));

  const renames: StockIssuePlan['renames'] = [{ from: names[renamingIdx], to: matched }];
  names[renamingIdx] = matched;
  others.slice(0, remaining.length).forEach(({ i }, k) => {
    renames.push({ from: names[i], to: remaining[k] });
    names[i] = remaining[k];
  });

  return { matched, names, renames };
}
