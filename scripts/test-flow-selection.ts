// Selecting several flow cells and moving them as a group.
//
// The rules being pinned down here are the ones a debater would notice going
// wrong mid-round: a group keeps its internal spacing when it moves, a move
// overwrites what it lands on (never silently shuffles unrelated rows), and a
// move that would run off the grid does nothing rather than collapsing the
// group against the edge.
//
// Run:  npx tsx scripts/test-flow-selection.ts

import {
  toggleCell, rangeTo, planMove, planDrop, applyMove, applyPaste, insertCells,
  clearCells, selectionKeys, isSelected, cellKey,
} from '../src/lib/flowSelection';

const ROWS = 60, COLS = 7;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n[1] Building a selection with ⌘-click');
{
  const a = toggleCell(null, 3, 1);
  check('first click selects one cell', eq(a, { col: 1, rows: [3] }));
  const b = toggleCell(a, 5, 1);
  check('a second click adds to it', eq(b, { col: 1, rows: [3, 5] }));
  const c = toggleCell(b, 4, 1);
  check('rows stay sorted regardless of click order', eq(c, { col: 1, rows: [3, 4, 5] }));
  const d = toggleCell(c, 4, 1);
  check('clicking a selected cell removes it', eq(d, { col: 1, rows: [3, 5] }));
  check('removing the last cell clears the selection',
    toggleCell(toggleCell(null, 2, 0), 2, 0) === null);
  // One column at a time: a group spanning two columns has no sane ⌘← behaviour.
  check('clicking into another column starts over',
    eq(toggleCell(c, 9, 4), { col: 4, rows: [9] }));
}

console.log('\n[2] Shift-click ranges');
{
  check('anchor above, click below', eq(rangeTo(2, 5, 0), { col: 0, rows: [2, 3, 4, 5] }));
  check('and the same the other way round', eq(rangeTo(5, 2, 0), { col: 0, rows: [2, 3, 4, 5] }));
  check('a range onto itself is one cell', eq(rangeTo(7, 7, 3), { col: 3, rows: [7] }));
}

console.log('\n[3] Where a move lands');
{
  const sel = { col: 2, rows: [3, 4, 9] };
  const down = planMove(sel, 1, 0, ROWS, COLS)!;
  check('every row shifts by one', eq(down.next.rows, [4, 5, 10]));
  check('the gap inside the group is preserved', down.next.rows[2] - down.next.rows[1] === 5);
  check('the column is unchanged', down.next.col === 2);
  check('sources and destinations are both counted as touched',
    down.touched.has('3-2') && down.touched.has('4-2') && down.touched.has('10-2'));

  const right = planMove(sel, 0, 1, ROWS, COLS)!;
  check('a sideways move keeps the rows', eq(right.next.rows, [3, 4, 9]));
  check('and lands in the next column', right.next.col === 3);

  check('a move off the left edge is refused', planMove({ col: 0, rows: [1] }, 0, -1, ROWS, COLS) === null);
  check('a move off the right edge is refused', planMove({ col: COLS - 1, rows: [1] }, 0, 1, ROWS, COLS) === null);
  check('a move off the top is refused', planMove({ col: 0, rows: [0, 2] }, -1, 0, ROWS, COLS) === null);
  check('a move off the bottom is refused', planMove({ col: 0, rows: [ROWS - 1] }, 1, 0, ROWS, COLS) === null);
  // Refusing beats clamping for the keyboard: silently squashing the group
  // against the last row would look like ⌘↓ corrupted the selection.
  check('a partly-off-grid group is refused whole, not clamped',
    planMove({ col: 0, rows: [ROWS - 2, ROWS - 1] }, 1, 0, ROWS, COLS) === null);
  check('a no-op move returns null', planMove({ col: 0, rows: [1] }, 0, 0, ROWS, COLS) === null);
  check('an empty selection moves nowhere', planMove({ col: 0, rows: [] }, 1, 0, ROWS, COLS) === null);
  check('no selection at all moves nowhere', planMove(null, 1, 0, ROWS, COLS) === null);
}

console.log('\n[4] Dropping a dragged group');
{
  const sel = { col: 1, rows: [10, 11, 12] };
  // Grabbed the middle cell and dropped it on row 20 — the group follows the
  // cell that was actually under the cursor.
  const p = planDrop(sel, 11, 20, 3, ROWS, COLS)!;
  check('the grabbed cell lands where it was dropped', p.next.rows[1] === 20);
  check('the rest of the group follows it', eq(p.next.rows, [19, 20, 21]));
  check('and it lands in the dropped-on column', p.next.col === 3);

  // A drag CAN clamp — the pointer wanders past the end of the grid and
  // stopping at the edge is the only sane reading of that gesture.
  const low = planDrop({ col: 0, rows: [0, 1] }, 0, ROWS - 1, 0, ROWS, COLS)!;
  check('a drag past the bottom clamps instead of failing', eq(low.next.rows, [ROWS - 2, ROWS - 1]));
}

console.log('\n[5] Inserting pushes what was there down — it never overwrites');
{
  const cells: Record<string, string> = { '3-0': 'aff', '4-0': 'link', '7-0': 'ALREADY HERE' };
  const plan = planMove({ col: 0, rows: [3, 4] }, 3, 0, ROWS, COLS)!;
  const out = applyMove(cells, plan, ROWS)!;
  check('content arrives at the destination', out.cells['6-0'] === 'aff' && out.cells['7-0'] === 'link');
  check('the cell that was there is NOT destroyed', Object.values(out.cells).includes('ALREADY HERE'));
  check('it slid down to the next free row', out.cells['8-0'] === 'ALREADY HERE');
  check('and its move is reported for the arrows to follow', out.shifted.get('7-0') === '8-0');
  check('the sources are emptied', !('3-0' in out.cells) && !('4-0' in out.cells));
  check('the input map is not mutated', cells['3-0'] === 'aff' && cells['7-0'] === 'ALREADY HERE');

  // The slide cascades through a run of filled rows, then stops at the first
  // gap — content past the gap must not be dragged along with it.
  const run = insertCells({ '2-0': 'a', '3-0': 'b', '5-0': 'far' }, 0, [2], ['new'], ROWS)!;
  check('a contiguous run is pushed down together', run.cells['3-0'] === 'a' && run.cells['4-0'] === 'b');
  check('the inserted cell takes the row', run.cells['2-0'] === 'new');
  check('content past the gap is left alone', run.cells['5-0'] === 'far');
  check('and is not reported as shifted', !run.shifted.has('5-0'));

  // A same-column nudge: the rows the selection vacates are what make room for
  // it, so lifting has to happen before the insert looks for space.
  const nudge = planMove({ col: 0, rows: [3, 4] }, 1, 0, ROWS, COLS)!;
  const out2 = applyMove({ '3-0': 'a', '4-0': 'b' }, nudge, ROWS)!;
  check('an overlapping nudge keeps both cells', out2.cells['4-0'] === 'a' && out2.cells['5-0'] === 'b');
  check('and frees only the row it actually left', !('3-0' in out2.cells));
  check('a nudge into free space displaces nothing', out2.shifted.size === 0);

  // Nudging into an occupied row pushes the neighbour ALONG rather than
  // trading places with it — this is the cost of insert semantics.
  const shove = planMove({ col: 0, rows: [3] }, 1, 0, ROWS, COLS)!;
  const out3 = applyMove({ '3-0': 'mine', '4-0': 'theirs' }, shove, ROWS)!;
  check('the moved cell takes the row', out3.cells['4-0'] === 'mine');
  check('the neighbour is pushed along, not swapped', out3.cells['5-0'] === 'theirs');
  check('so the row it came from is now empty', !('3-0' in out3.cells));

  // Moving a blank disturbs nothing at all.
  const blank = planMove({ col: 0, rows: [1] }, 1, 0, ROWS, COLS)!;
  check('a blank source leaves the destination untouched',
    applyMove({ '2-0': 'old' }, blank, ROWS)!.cells['2-0'] === 'old');
}

console.log('\n[6] Refusing a move with nowhere to put the displaced cells');
{
  // A column full from the drop point to the bottom has no free row to absorb
  // anything. Refusing beats pushing an argument off the sheet.
  const full: Record<string, string> = {};
  for (let r = 2; r < ROWS; r++) full[cellKey(r, 0)] = `row ${r}`;
  check('an insert with no room below is refused', insertCells(full, 0, [5], ['x'], ROWS) === null);
  check('one free row is enough', insertCells({ ...full, [cellKey(ROWS - 1, 0)]: '' }, 0, [5], ['x'], ROWS) !== null);

  // Nudging DOWN inside a full column is refused too. Lifting the cell frees
  // the row it came from, but that row is ABOVE the insertion point and a push
  // only ever goes down, so there is still nothing to absorb the neighbour.
  // The keypress does nothing, which is the right outcome: the alternative is
  // shoving the bottom argument off the sheet.
  const down = planMove({ col: 0, rows: [2] }, 1, 0, ROWS, COLS)!;
  check('nudging down in a full column is refused', applyMove(full, down, ROWS) === null);

  // Nudging UP is fine even then — it moves INTO the gap it just made.
  const upFull: Record<string, string> = {};
  for (let r = 0; r < ROWS; r++) upFull[cellKey(r, 0)] = `row ${r}`;
  const up = planMove({ col: 0, rows: [5] }, -1, 0, ROWS, COLS)!;
  const upRes = applyMove(upFull, up, ROWS);
  check('nudging up in a full column works', upRes !== null);
  check('and pushes the cell above it back down', upRes!.cells['5-0'] === 'row 4');
  check('while the moved cell takes the row', upRes!.cells['4-0'] === 'row 5');
}

console.log('\n[7] Cross-tab paste and delete');
{
  const landed = applyPaste({ '5-1': 'existing' }, 1, [5, 6], ['moved', 'also'], ROWS)!;
  check('a cross-tab drop inserts at the target', landed.cells['5-1'] === 'moved');
  check('and pushes the sheet\'s own cell down', landed.cells['6-1'] === 'existing' || landed.cells['7-1'] === 'existing');
  check('nothing is lost', Object.values(landed.cells).filter((v) => v === 'existing').length === 1);
  check('the rest of the group lands too', Object.values(landed.cells).includes('also'));

  const cleared = clearCells({ '1-0': 'x', '2-0': 'y', '3-0': 'z' }, ['1-0', '3-0']);
  check('delete empties exactly the selected cells', !('1-0' in cleared) && !('3-0' in cleared));
  check('and leaves the others alone', cleared['2-0'] === 'y');
}

console.log('\n[8] Small helpers');
{
  check('keys are row-col', cellKey(4, 2) === '4-2');
  check('selectionKeys walks the group', eq(selectionKeys({ col: 2, rows: [1, 3] }), ['1-2', '3-2']));
  check('selectionKeys of nothing is empty', eq(selectionKeys(null), []));
  check('isSelected finds a member', isSelected({ col: 2, rows: [1, 3] }, 3, 2));
  check('isSelected rejects the same row in another column', !isSelected({ col: 2, rows: [3] }, 3, 1));
  check('isSelected of nothing is false', !isSelected(null, 0, 0));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
