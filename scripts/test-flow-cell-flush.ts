// Regression tests for the "arguments teleported between tabs" bug.
//
// FlowView keeps the sheet being edited in a mutable ref (cellsRef) and merges
// it back into the sheets array on every save/switch/persist. That merge used to
// be by INDEX (sheets[activeSheetIdx]) — and activeSheetIdx can be momentarily
// stale relative to the buffer (post-render effect timing, async AI writes,
// drag-reorder shifting indices), so the live buffer got written into whatever
// sheet happened to sit at that index. Mid-round, that reads as one tab's
// arguments appearing on another.
//
// flushCellsIntoSheets matches by the buffer's OWNER SHEET ID instead, which
// makes the corruption unwritable. These tests pin that behavior.
//
// Run:  npx tsx scripts/test-flow-cell-flush.ts

import { flushCellsIntoSheets } from '../src/lib/flowCellFlush';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}

const sheets = () => [
  { id: 'a', name: 'Politics DA', cells: { '0-0': 'politics uniqueness' } },
  { id: 'b', name: 'Cap K',       cells: { '0-0': 'cap link' } },
  { id: 'c', name: 'Case',        cells: { '0-0': 'inherency' } },
];

console.log('\n[1] flushCellsIntoSheets — writes only into the owning sheet');
{
  const out = flushCellsIntoSheets(sheets(), 'b', { '0-0': 'EDITED cap link', '1-0': 'new card' });
  check('owner sheet receives the buffer', out[1].cells['0-0'] === 'EDITED cap link' && out[1].cells['1-0'] === 'new card');
  check('sheet before the owner is untouched', out[0].cells['0-0'] === 'politics uniqueness');
  check('sheet after the owner is untouched', out[2].cells['0-0'] === 'inherency');
  check('no sheet gained a foreign cell', out.filter((s) => s.cells['1-0'] !== undefined).length === 1);
}

console.log('\n[2] The teleport scenario — owner id no longer matches its old index');
{
  // User edits "Cap K" (index 1), then drags it to the front. Anything that
  // flushes with a stale index 1 would previously overwrite whatever moved into
  // that slot. Matching by id follows the sheet to its new position instead.
  const reordered = [sheets()[1], sheets()[0], sheets()[2]]; // Cap K dragged to front
  const out = flushCellsIntoSheets(reordered, 'b', { '0-0': 'EDITED cap link' });
  check('buffer follows its sheet to the new index', out[0].id === 'b' && out[0].cells['0-0'] === 'EDITED cap link');
  check('the sheet now sitting at the old index is NOT overwritten', out[1].id === 'a' && out[1].cells['0-0'] === 'politics uniqueness');
}

console.log('\n[3] Unknown / missing owner — drop the buffer, never misfile it');
{
  const deleted = sheets().filter((s) => s.id !== 'b'); // the edited sheet was deleted
  const out = flushCellsIntoSheets(deleted, 'b', { '0-0': 'orphaned edit' });
  check('no surviving sheet absorbs an orphaned buffer', out.every((s) => s.cells['0-0'] !== 'orphaned edit'));
  check('surviving sheets keep their own content', out[0].cells['0-0'] === 'politics uniqueness' && out[1].cells['0-0'] === 'inherency');

  const noOwner = flushCellsIntoSheets(sheets(), null, { '0-0': 'nobody owns this' });
  check('null owner writes nothing', noOwner.every((s) => s.cells['0-0'] !== 'nobody owns this'));
}

console.log('\n[4] Purity — never mutates the input');
{
  const input = sheets();
  const before = JSON.stringify(input);
  const out = flushCellsIntoSheets(input, 'a', { '0-0': 'changed' });
  check('input array is not mutated', JSON.stringify(input) === before);
  check('output is a different array', out !== input);
  check('the buffer is copied, not aliased', out[0].cells !== input[0].cells);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
