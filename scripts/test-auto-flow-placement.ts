// Exercises the deterministic column/row helpers Auto Flow's write step depends
// on (src/lib/autoFlowPlacement.ts) — case-insensitive exact column matching and
// first-empty-row scanning. These are cheap to get subtly wrong (off-by-one on
// row index, case sensitivity, "0 is falsy" bugs), so they get a dedicated test
// like extractFlowCardsFromXml does in test-docx-flow-cards.ts.
//
// Run:  npx tsx scripts/test-auto-flow-placement.ts

import { findColumnIndex, firstEmptyRow, inferEventFromPockets, inferVariantFromHats } from '../src/lib/autoFlowPlacement';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}

console.log('\n[1] findColumnIndex — case-insensitive exact match');
{
  const cols = ['1AC', '1NC', '2AC', '2NC/1NR', '1AR', '2NR', '2AR'];
  check('exact case match', findColumnIndex(cols, '1AC') === 0);
  check('case-insensitive match', findColumnIndex(cols, '2nc/1nr') === 3);
  check('leading/trailing whitespace tolerated', findColumnIndex(cols, '  2AR  ') === 6);
  check('no match returns -1', findColumnIndex(cols, '2NC') === -1, 'AI must echo the combined column verbatim, not a sub-label');
  check('empty needle returns -1', findColumnIndex(cols, '') === -1);
  check('renamed columns still match verbatim', findColumnIndex(['Neg Block', 'Case'], 'neg block') === 0);
}

console.log('\n[2] firstEmptyRow — scans top to bottom, 0-based');
{
  check('empty column returns row 0', firstEmptyRow({}, 2, 10) === 0);
  check('skips occupied rows', firstEmptyRow({ '0-2': 'Tag one<br>Cite', '1-2': 'Tag two<br>Cite' }, 2, 10) === 2);
  check('does not confuse other columns', firstEmptyRow({ '0-3': 'Different column' }, 2, 10) === 0);
  check('whitespace-only cell counts as empty', firstEmptyRow({ '0-2': '   ' }, 2, 10) === 0);
  const full: Record<string, string> = {};
  for (let ri = 0; ri < 5; ri++) full[`${ri}-1`] = `Row ${ri}`;
  check('full column returns -1', firstEmptyRow(full, 1, 5) === -1);
  check('respects numRows bound (does not scan past it)', firstEmptyRow(full, 1, 4) === -1);
}

console.log('\n[3] inferEventFromPockets — policy vs PF default for a new flow');
{
  check('policy labels detected', inferEventFromPockets(['1AC', 'Redundancy Advantage', '2NC']) === 'policy');
  check('case-insensitive policy label', inferEventFromPockets(['1ac']) === 'policy');
  check('PF labels detected', inferEventFromPockets(['Pro Case', 'Con Rebuttal']) === 'pf');
  check('PF "final focus" variant', inferEventFromPockets(['Con Final Focus']) === 'pf');
  check('PF "FF" abbreviation', inferEventFromPockets(['Pro FF']) === 'pf');
  check('no signal returns null', inferEventFromPockets(['Uniqueness', 'Link', null, undefined]) === null);
  check('empty array returns null', inferEventFromPockets([]) === null);
  check('mixed signals tie-break to policy', inferEventFromPockets(['1AC', 'Pro Case']) === 'policy');
  check('"pro"/"con" alone (no keyword) is not a PF hit', inferEventFromPockets(['Pro Choice Advantage']) === null);
}

console.log('\n[4] inferVariantFromHats — stock-issues vs advantage default for a new policy flow');
{
  check('advantage hats detected', inferVariantFromHats(['Advantage 1', 'Redundancy Advantage']) === 'advantage');
  check('"adv" abbreviation detected', inferVariantFromHats(['Adv 2 — Economy']) === 'advantage');
  check('stock-issue hats detected', inferVariantFromHats(['Inherency', 'Harms', 'Solvency']) === 'stock-issues');
  check('significance counts as stock', inferVariantFromHats(['Significance']) === 'stock-issues');
  check('solvency alone is NOT a stock signal (advantage affs have it too)', inferVariantFromHats(['Solvency']) === null);
  check('DA/CP/K neg hats give no aff-structure signal', inferVariantFromHats(['Politics DA', 'States CP', 'Cap K']) === null);
  check('mixed signals tie-break to advantage', inferVariantFromHats(['Advantage 1', 'Inherency']) === 'advantage');
  check('no signal returns null', inferVariantFromHats(['Uniqueness', null, undefined]) === null);
  check('empty array returns null', inferVariantFromHats([]) === null);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
