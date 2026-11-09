// Tests for lib/flowPlace.ts: putting hand-placed cards into a flow column.
//
// Run:  npx tsx scripts/test-flow-place.ts

import { placeRows, nextFreeRow } from '../src/lib/flowPlace';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}

const sheet = () => ({
  cells: { '0-1': 'A', '1-1': 'B', '2-1': 'C', '0-2': 'X' } as Record<string, string>,
  arrows: [{ from: '1-1', to: '1-2' }, { fx1: 0.1 } as any],
  aiCells: ['2-1'],
});

console.log('\n[1] an empty cell');
{
  const r = placeRows(sheet(), 1, 3, 'cell', ['D']);
  check('goes where it was put', r.sheet.cells['3-1'] === 'D' && r.rows.join() === '3');
  check('nothing else moves', r.sheet.cells['2-1'] === 'C' && r.sheet.cells['0-2'] === 'X');
  check('depth is one past the last row', r.depth === 4);
}

console.log('\n[2] between two cells');
{
  const r = placeRows(sheet(), 1, 1, 'insert', ['N']);
  check('the new card sits between A and B', r.sheet.cells['0-1'] === 'A' && r.sheet.cells['1-1'] === 'N' && r.sheet.cells['2-1'] === 'B' && r.sheet.cells['3-1'] === 'C');
  check('other columns stay put', r.sheet.cells['0-2'] === 'X');
  check('arrow ends on moved cells move with them', (r.sheet.arrows[0] as any).from === '2-1' && (r.sheet.arrows[0] as any).to === '1-2');
  check('free-form arrows are untouched', (r.sheet.arrows[1] as any).fx1 === 0.1);
  check('AI marks follow their cell', r.sheet.aiCells.join() === '3-1');
  const two = placeRows(sheet(), 1, 1, 'insert', ['N1', 'N2']);
  check('several open the gap by that many, in order', two.sheet.cells['1-1'] === 'N1' && two.sheet.cells['2-1'] === 'N2' && two.sheet.cells['3-1'] === 'B');
}

console.log('\n[3] a block placed from an empty cell that runs into filled ones');
{
  const s = { cells: { '0-0': 'A', '2-0': 'Z' } as Record<string, string> };
  const r = placeRows(s, 0, 1, 'cell', ['P', 'Q', 'R']);
  check('fills the empty cell, then makes room as it goes', ['A', 'P', 'Q', 'R', 'Z'].every((v, i) => r.sheet.cells[`${i}-0`] === v), JSON.stringify(r.sheet.cells));
  check('rows reported in order', r.rows.join() === '1,2,3');
  check('the original sheet is not changed', s.cells['1-0'] === undefined);
}

console.log('\n[4] next free row');
{
  check('after the last filled cell', nextFreeRow(sheet().cells, 1) === 3);
  check('0 for an empty column', nextFreeRow(sheet().cells, 4) === 0);
  check('blank HTML does not count', nextFreeRow({ '5-0': '  ' }, 0) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
