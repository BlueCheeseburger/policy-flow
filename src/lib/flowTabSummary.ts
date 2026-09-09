// What the AI tab-summary tooltip is allowed to read.
//
// Two rules, both about only spending an AI call where it can produce a real
// answer:
//
// 1. ONLY AUTO-FLOWED SHEETS. A tab the debater typed themselves is already in
//    their own words — they don't need a machine to tell them what "Politics"
//    says, and firing a call on every hover across a hand-built flow is spend
//    for nothing. Auto Flow stamps `autoFlowRole` on every sheet it writes, and
//    that stamp is the eligibility test.
//
// 2. ONE COLUMN, NOT THE WHOLE SHEET. A tab holds a position AND every answer
//    to it, and feeding all of that in produced a summary of the argument's
//    whole history rather than of the argument. The position is stated once, in
//    the speech that introduced it: the 1AC for an advantage, the 1NC for an
//    off-case position. That column alone is the summary's input.
//
// Pure — see scripts/test-flow-tab-summary.ts.

/** Auto Flow's own classification of a tab, stamped on the sheet as it writes. */
export type SheetRole = 'advantage' | 'offcase';

export interface SummarySheetLike {
  /** Present on any sheet Auto Flow wrote into. `null` means it wrote here but
   *  couldn't classify the tab, which still counts as auto-flowed. */
  autoFlowRole?: SheetRole | null;
  /** Legacy marker: cells Auto Flow's summarize mode wrote. Only Auto Flow ever
   *  sets it, so a sheet carrying it was auto-flowed even if it predates
   *  `autoFlowRole`. Without this, every tab flowed before that field existed
   *  would silently lose its tooltip summary. */
  aiCells?: string[];
}

export function wasAutoFlowed(sheet: SummarySheetLike | null | undefined): boolean {
  if (!sheet) return false;
  return sheet.autoFlowRole !== undefined || (sheet.aiCells?.length ?? 0) > 0;
}

// The constructive that INTRODUCES each kind of position. Matched by name so a
// renamed or reordered column still resolves; the index is only the fallback.
const POLICY_SOURCE: Record<SheetRole, { re: RegExp; fallback: number }> = {
  advantage: { re: /^\s*1\s*ac\b/i, fallback: 0 },
  offcase:   { re: /^\s*1\s*nc\b/i, fallback: 1 },
};

/**
 * Which column the summary should read, or null to read the whole sheet.
 *
 * Null is returned for an unclassified tab (`autoFlowRole: null`) — with no idea
 * whether it's aff or neg, guessing a column would be worse than the old
 * behavior, so it falls back to reading everything.
 *
 * PF has no 1AC/1NC. Both teams read a case, so the equivalent of "the speech
 * that introduced this" is the FIRST case column for the side that speaks first
 * and the second one for the responding side — which, because the PF column
 * arrays are ordered by speech, is just the first and second "…Case" column
 * whichever pro/con order is in play.
 */
export function summaryColumnFor(
  role: SheetRole | null | undefined,
  columns: string[],
  event: 'policy' | 'pf',
): number | null {
  if (!role) return null;
  const cols = columns ?? [];
  if (cols.length === 0) return null;

  if (event === 'policy') {
    const { re, fallback } = POLICY_SOURCE[role];
    const byName = cols.findIndex((c) => re.test(String(c ?? '')));
    if (byName !== -1) return byName;
    return fallback < cols.length ? fallback : null;
  }

  const cases = cols
    .map((c, i) => ({ i, name: String(c ?? '') }))
    .filter(({ name }) => /\bcase\b/i.test(name) || /\bconstructive\b/i.test(name));
  const pick = role === 'advantage' ? cases[0] : cases[1];
  if (pick) return pick.i;
  const fallback = role === 'advantage' ? 0 : 1;
  return fallback < cols.length ? fallback : null;
}

/**
 * The tag/cite lines the summary sees, top to bottom.
 *
 * `col` of null means every column (an unclassified tab). `toText` is injected
 * so this stays free of the DOM — the caller passes `htmlToText`.
 */
export function summaryEntries(
  cells: Record<string, string>,
  col: number | null,
  toText: (html: string) => string,
): string[] {
  return Object.entries(cells ?? {})
    .map(([key, html]) => {
      const [r, c] = key.split('-').map(Number);
      return { r, c, text: toText(String(html ?? '')).trim() };
    })
    .filter((e) => e.text && Number.isFinite(e.r) && Number.isFinite(e.c))
    .filter((e) => col === null || e.c === col)
    .sort((a, b) => a.c - b.c || a.r - b.r)
    .map((e) => e.text);
}

/**
 * A signature of just the text the summary actually reads, so a cached summary
 * is only invalidated by a change to THAT column. Answers typed into the 2AC
 * don't change what the 1NC position is, and regenerating for them would be an
 * AI call that returns the same sentence.
 */
export function summarySignature(entries: string[]): string {
  const joined = entries.join('|');
  let hash = 0;
  for (let i = 0; i < joined.length; i++) hash = (hash * 31 + joined.charCodeAt(i)) | 0;
  return `${entries.length}:${hash}`;
}
