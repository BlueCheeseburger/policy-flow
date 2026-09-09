// Pure helpers for Auto Flow's write step (src/components/AutoFlow.tsx). Split out
// so scripts/test-auto-flow-placement.ts can exercise them headlessly, the same
// way scripts/test-docx-flow-cards.ts exercises extractFlowCardsFromXml.
//
// Auto Flow's classify step (ai:autoFlowClassify) already does the "fuzzy"
// semantic matching (which sheet a hat topically belongs to, etc.) — these
// helpers are the deterministic, exact-match layer that turns an AI-proposed
// column/row into an actual cell address once the user has approved the
// placement. Column matching is case-insensitive EXACT match only (the AI was
// told to echo one of the flow's real column labels back verbatim); there is no
// fuzzy tab-name matching on this side, that's entirely the AI's job upstream.
//
// Deliberately takes `numRows` as a plain parameter rather than importing
// FlowView's NUM_ROWS constant — this file (and its headless test,
// scripts/test-auto-flow-placement.ts) must stay importable outside a browser/
// React runtime, and FlowView.tsx pulls in React + browser-only modules at
// import time. Callers in AutoFlow.tsx pass NUM_ROWS from FlowView.tsx in.

/** Case-insensitive exact match against the flow's actual current column labels.
 * Returns -1 if no column matches (the caller should skip the placement). */
export function findColumnIndex(columns: string[], columnName: string): number {
  const needle = (columnName || '').trim().toLowerCase();
  if (!needle) return -1;
  return columns.findIndex((c) => c.trim().toLowerCase() === needle);
}

/** First row (0-based) in the given column of `cells` with no content, scanning
 * top to bottom. Returns -1 if every row 0..numRows-1 is already occupied. */
export function firstEmptyRow(cells: Record<string, string>, ci: number, numRows: number): number {
  for (let ri = 0; ri < numRows; ri++) {
    const v = cells[`${ri}-${ci}`];
    if (!v || !v.trim()) return ri;
  }
  return -1;
}

// Cheap heuristic Auto Flow's target step uses to pre-select policy vs. PF for a
// NEW flow, before the user confirms (they can always override it). Looks only
// at pocket labels (the speech-label heading, e.g. "1AC", "Con Rebuttal") across
// every extracted card — never card bodies. Deliberately simple/regex-based
// rather than AI-driven: this only picks a sensible default for a dropdown the
// user reviews, so it doesn't need to be perfect, just fast and legible. If a doc
// mixes both label styles (e.g. a merged aff/neg packet) it's genuinely
// ambiguous — treated as a policy tie-break rather than guessing further, since
// PF's word-based labels ("pro case", "con rebuttal") are broader English phrases
// more prone to an accidental substring hit than a policy code like "1AC" is.
const POLICY_LABEL_RE = /\b(1AC|2AC|1NC|2NC|1AR|2AR|1NR|2NR)\b/i;
const PF_LABEL_RE = /\b(pro|con)\s+(case|rebuttal|summary|final\s*focus|ff|constructive)\b/i;

export function inferEventFromPockets(pockets: (string | null | undefined)[]): 'policy' | 'pf' | null {
  const text = pockets.filter((p): p is string => !!p).join(' | ');
  const policyHit = POLICY_LABEL_RE.test(text);
  const pfHit = PF_LABEL_RE.test(text);
  if (policyHit && !pfHit) return 'policy';
  if (pfHit && !policyHit) return 'pf';
  if (policyHit && pfHit) return 'policy';
  return null; // no usable signal — caller falls back to the app's current event
}

// Same idea as inferEventFromPockets, one level deeper: for a NEW *policy* flow,
// pre-select Stock Issues vs. Advantage from the aff's own structure. The tell is
// in the hat/block heading text, NOT the pocket (speech label):
//   - Advantage affs name their contentions "Advantage 1", "Adv 2", "Economy
//     Advantage", etc.
//   - Stock-issues affs use the classic "Inherency" / "Harms" (a.k.a.
//     "Significance") headings.
// "Solvency" is deliberately NOT a stock-issues signal — advantage affs have a
// solvency contention too, so it doesn't distinguish the two. DA/CP/K/T headings
// are neg/off-case and say nothing about the aff's structure, so they're ignored.
// Best-effort only — this just picks the default for a toggle the user reviews.
const ADVANTAGE_HAT_RE = /\badv(antage)?s?\b/i;         // "advantage", "adv", "advantages", "adv 1"
const STOCK_HAT_RE = /\b(inherency|significance|harms)\b/i;

export function inferVariantFromHats(hats: (string | null | undefined)[]): 'stock-issues' | 'advantage' | null {
  const text = hats.filter((h): h is string => !!h).join(' | ');
  const advHit = ADVANTAGE_HAT_RE.test(text);
  const stockHit = STOCK_HAT_RE.test(text);
  if (advHit && !stockHit) return 'advantage';
  if (stockHit && !advHit) return 'stock-issues';
  if (advHit && stockHit) return 'advantage'; // tie-break: modern policy is overwhelmingly advantage-structured
  return null; // no usable signal — caller keeps the app's default (stock-issues)
}
