// Tests for the "create a sheet, then clean up unused defaults" rule.
//
// The behavior this replaced: Auto Flow used to look for an empty default tab
// ("Off 3") and RENAME it into place. That repurposed slots the user might have
// been holding, and made tab order depend on which placeholder happened to be
// free rather than on the order positions came up in the document.
//
// Run:  npx tsx scripts/test-flow-sheet-naming.ts

import {
  isPlaceholderSheetName, isSheetEmpty, pruneUnnamedEmptySheets,
} from '../src/lib/flowSheetNaming';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}

const sheet = (name: string, cells: Record<string, string> = {}) => ({ name, cells });

console.log('\n[1] isPlaceholderSheetName — app-generated names only');
{
  for (const n of ['Off 1', 'Off 4', 'Adv 1', 'Advantage 2', 'Contention 3', 'Sheet 2']) {
    check(`"${n}" is a placeholder`, isPlaceholderSheetName(n));
  }
  for (const n of ['Off 1', 'ADV 2', 'contention 1', 'sheet 9']) {
    check(`"${n}" matches case-insensitively`, isPlaceholderSheetName(n));
  }
  check('"Off1" (no space) still matches', isPlaceholderSheetName('Off1'));
  check('surrounding whitespace is ignored', isPlaceholderSheetName('  Off 2  '));

  for (const n of ['Politics DA', 'Case', 'RFD/Notes', 'Turns', 'Solvency', 'Fism DA', 'Off-Case Notes']) {
    check(`"${n}" is a real name`, !isPlaceholderSheetName(n));
  }
  check('"Off" alone is not a placeholder (no number)', !isPlaceholderSheetName('Off'));
  check('"Adv" alone is not a placeholder', !isPlaceholderSheetName('Adv'));
  check('"2 Off" is not a placeholder', !isPlaceholderSheetName('2 Off'));
  check('a name that merely starts with Off is not a placeholder', !isPlaceholderSheetName('Off 1 Politics'));
  check('empty string is not a placeholder', !isPlaceholderSheetName(''));
}

console.log('\n[2] isSheetEmpty — whitespace does not count as content');
{
  check('no cells at all is empty', isSheetEmpty(sheet('x')));
  check('missing cells object is empty', isSheetEmpty({ name: 'x' } as any));
  check('blank strings are empty', isSheetEmpty(sheet('x', { '0-0': '', '1-0': '   ' })));
  check('a newline-only cell is empty', isSheetEmpty(sheet('x', { '0-0': '\n\n' })));
  check('real text is not empty', !isSheetEmpty(sheet('x', { '2-1': 'perm do both' })));
  check('one filled cell among blanks is not empty', !isSheetEmpty(sheet('x', { '0-0': '', '3-2': 'a' })));
}

console.log('\n[3] pruneUnnamedEmptySheets — the four combinations');
{
  const out = pruneUnnamedEmptySheets([
    sheet('Case', { '0-0': 'plan text' }),   // named + content   → keep
    sheet('Politics DA'),                     // named + empty     → keep (position existed)
    sheet('Off 2', { '0-1': 'link' }),        // default + content → keep
    sheet('Off 3'),                           // default + empty   → DROP
  ]);
  check('named+content kept', out.some((s) => s.name === 'Case'));
  check('named+empty kept — an empty "Politics DA" still tells you the position existed',
    out.some((s) => s.name === 'Politics DA'));
  check('default+content kept', out.some((s) => s.name === 'Off 2'));
  check('default+empty dropped', !out.some((s) => s.name === 'Off 3'));
  check('exactly one sheet removed', out.length === 3, `got ${out.length}`);
}

console.log('\n[4] Never leaves a flow with zero sheets');
{
  const allDisposable = [sheet('Off 1'), sheet('Adv 1'), sheet('Sheet 2')];
  const out = pruneUnnamedEmptySheets(allDisposable);
  check('an all-empty default flow is returned untouched', out.length === 3);
  check('the original array is handed back, not a truncated one', out === allDisposable);
  check('empty input does not throw', pruneUnnamedEmptySheets([]).length === 0);
}

console.log('\n[5] Order is preserved — tab order is meaningful');
{
  const out = pruneUnnamedEmptySheets([
    sheet('Case', { '0-0': 'a' }),
    sheet('Off 1'),                       // dropped
    sheet('Heg Adv', { '0-0': 'b' }),
    sheet('Adv 3'),                       // dropped
    sheet('Politics DA', { '0-1': 'c' }),
  ]);
  check('survivors keep their relative order',
    out.map((s) => s.name).join('|') === 'Case|Heg Adv|Politics DA', out.map((s) => s.name).join('|'));
}

console.log('\n[6] The real Auto Flow shape — a 2-advantage aff into a default policy layout');
{
  // Default stock-issues layout plus the tabs an Auto Flow run appended.
  const afterRun = [
    sheet('Case', { '0-0': 'plan' }),
    sheet('Inherency'),        // structural, named → kept even though blank
    sheet('Solvency'),         // structural, named → kept
    sheet('Off 1'), sheet('Off 2'), sheet('Off 3'), sheet('Off 4'), // untouched defaults
    sheet('Adv 1'), sheet('Adv 2'), sheet('Adv 3'),
    sheet('Heg Adv', { '0-0': 'heg card' }),        // appended by the run
    sheet('Econ Adv', { '0-0': 'econ card' }),      // appended by the run
    sheet('Fism DA', { '0-1': 'link' }),            // appended by the run
  ];
  const out = pruneUnnamedEmptySheets(afterRun);
  check('all seven unused numbered slots are gone', out.length === 6, `got ${out.length}`);
  check('the appended named tabs survive in document order',
    out.map((s) => s.name).join('|') === 'Case|Inherency|Solvency|Heg Adv|Econ Adv|Fism DA',
    out.map((s) => s.name).join('|'));
  check('advantages still precede off-case', out.findIndex((s) => s.name === 'Heg Adv') < out.findIndex((s) => s.name === 'Fism DA'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
