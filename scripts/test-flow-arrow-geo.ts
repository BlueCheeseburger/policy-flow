// Tests for arrow endpoints — the two shapes and the maths that resolves them.
//
// An arrow used to be anchored to two CELLS. Auto Flow still draws those (it
// knows which card answers which), but a hand-drawn arrow now carries its own
// free endpoints and snaps to nothing. Both live in one array, so the thing
// worth pinning down is that neither shape corrupts the other.
//
// Run:  npx tsx scripts/test-flow-arrow-geo.ts

import {
  isFreeArrow, isCellArrow, toFraction, fromFraction, straightPath, bumpArrow, dropArrowsTouching,
} from '../src/lib/flowArrowGeo';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}

const free = { id: 'f', fx1: 0.1, fy1: 0.2, fx2: 0.8, fy2: 0.9 };
const cell = { id: 'c', from: '3-1', to: '3-2' };

console.log('\n[1] Telling the two shapes apart');
{
  check('a free arrow is free', isFreeArrow(free));
  check('a free arrow is not a cell arrow', !isCellArrow(free));
  check('a cell arrow is a cell arrow', isCellArrow(cell));
  check('a cell arrow is not free', !isFreeArrow(cell));
  check('a half-written free arrow is not free', !isFreeArrow({ id: 'x', fx1: 0.1, fy1: 0.2 }));
  check('an empty arrow is neither', !isFreeArrow({ id: 'x' }) && !isCellArrow({ id: 'x' }));
  // fx of 0 is a real coordinate (the very left edge), not "missing".
  check('zero is a valid coordinate, not absent',
    isFreeArrow({ id: 'z', fx1: 0, fy1: 0, fx2: 0, fy2: 0.5 }));
}

console.log('\n[2] Fractions survive a resize');
{
  check('a midpoint is 0.5', toFraction(300, 600) === 0.5);
  check('and comes back at the new size', fromFraction(0.5, 900) === 450);
  // The whole reason for fractions: zoom and column drags change the box.
  const f = toFraction(300, 600);
  check('the same point after a 1.5x zoom', fromFraction(f, 900) === 450);
  check('past the right edge is clamped in', toFraction(9999, 600) === 1);
  check('a negative is clamped to 0', toFraction(-50, 600) === 0);
  check('a zero-width box does not produce NaN', toFraction(100, 0) === 0);
  check('NaN in never comes back out', fromFraction(NaN, 600) === 0);
}

console.log('\n[3] Always one straight segment');
{
  check('straight, never curved', straightPath(1, 2, 3, 4) === 'M 1 2 L 3 4');
  check('no control points anywhere', !/[CQSTA]/.test(straightPath(0, 0, 500, 500)));
}

console.log('\n[4] Inserting a row moves cell arrows only');
{
  const bump = (k: string) => (k === '3-1' ? '4-1' : k);
  const movedCell = bumpArrow(cell, bump);
  check('a cell arrow follows its cell', movedCell.from === '4-1' && movedCell.to === '3-2');

  // The one that matters: a free arrow is anchored to the sheet, not a row.
  // Bumping it would be meaningless, and writing from/to onto it would silently
  // convert it into a cell arrow pointing at cells the user never chose.
  const movedFree = bumpArrow(free, bump);
  check('a free arrow is returned untouched', movedFree === free);
  check('and never grows cell keys',
    (movedFree as any).from === undefined && (movedFree as any).to === undefined);
  check('its coordinates are unchanged',
    movedFree.fx1 === 0.1 && movedFree.fy2 === 0.9);
}

console.log('\n[5] Moving cells drops the arrows that pointed at them');
{
  // An arrow means "this argument answers that one". Once either end has moved
  // or been overwritten, re-anchoring it would point the line at whatever now
  // happens to sit there — a claim the debater never made.
  const arrows = [
    { id: 'a', from: '3-1', to: '3-2' },
    { id: 'b', from: '9-1', to: '9-2' },
    { id: 'c', from: '5-0', to: '3-1' }, // points INTO a moved cell
    free,
  ];
  const kept = dropArrowsTouching(arrows, new Set(['3-1', '4-1']));
  check('an arrow leaving a moved cell is dropped', !kept.some((a) => a.id === 'a'));
  check('an arrow arriving at a moved cell is dropped too', !kept.some((a) => a.id === 'c'));
  check('an untouched arrow survives', kept.some((a) => a.id === 'b'));
  check('a free arrow is never dropped — it is anchored to the sheet, not a cell',
    kept.some((a) => a.id === 'f'));
  check('nothing touched means nothing changes', dropArrowsTouching(arrows, new Set()) === arrows);
  check('the input array is not mutated', arrows.length === 4);
  check('an empty arrow list stays empty', dropArrowsTouching([], new Set(['1-1'])).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
