// Tests for undo in a shared flow (src/lib/undoMerge.ts): a step reverts only
// what it changed, and partner edits survive undo however far back you go.
//
// Run:  npx tsx scripts/test-undo-merge.ts

import { mergeUndoStep, rebaseCell, rebaseArrows, type UndoSheet } from '../src/lib/undoMerge';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}
const sh = (id: string, cells: Record<string, string>, extra: Partial<UndoSheet> = {}): UndoSheet => ({ id, name: id, cells, arrows: [], ...extra });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

console.log('\n[1] a step reverts only its own change');
{
  const s0 = [sh('a', { '0-0': 'mine' })];
  const s1 = [sh('a', { '0-0': 'mine edited' })];                    // my edit
  const live = [sh('a', { '0-0': 'mine edited', '3-1': 'partner' })]; // partner typed after
  const r = mergeUndoStep(live, s1, s0);
  check('my edit is undone', r.sheets[0].cells['0-0'] === 'mine');
  check("partner's cell survives", r.sheets[0].cells['3-1'] === 'partner');
  check('only my cell is marked changed', [...(r.changed.get('a') ?? [])].join() === '0-0');
}

console.log('\n[2] undoing a new cell removes it; redo brings it back');
{
  const s0 = [sh('a', {})];
  const s1 = [sh('a', { '2-2': 'new' })];
  const undone = mergeUndoStep(s1, s1, s0);
  check('removed on undo', !('2-2' in undone.sheets[0].cells));
  const redone = mergeUndoStep(undone.sheets, s0, s1);
  check('back on redo', redone.sheets[0].cells['2-2'] === 'new');
}

console.log('\n[3] arrows follow the same rule');
{
  const arrow = { id: 'x', fx1: 0, fy1: 0, fx2: 1, fy2: 1 };
  const s0 = [sh('a', {}, { arrows: [arrow] })];
  const s1 = [sh('a', {}, { arrows: [] })];                           // I deleted it
  const r = mergeUndoStep(s1, s1, s0);
  check('undoing my delete restores the arrow', (r.sheets[0].arrows ?? []).length === 1);
  const partnerArrow = { id: 'p', fx1: 0.2, fy1: 0.2, fx2: 0.3, fy2: 0.3 };
  const liveWithPartner = [sh('a', { '1-1': 'mine' }, { arrows: [partnerArrow] })];
  const t0 = [sh('a', {}, { arrows: [] })];
  const t1 = [sh('a', { '1-1': 'mine' }, { arrows: [] })];            // my cell edit only
  const r2 = mergeUndoStep(liveWithPartner, t1, t0);
  check("a partner's arrow survives undoing an unrelated edit", (r2.sheets[0].arrows ?? []).length === 1);
}

console.log('\n[4] tabs');
{
  const s0 = [sh('a', {}), sh('b', { '0-0': 'tab b' })];
  const s1 = [sh('a', {})];                                            // I deleted tab b
  const r = mergeUndoStep(s1, s1, s0);
  check('undoing a tab delete brings it back with its cells', r.sheets.length === 2 && r.sheets[1].cells['0-0'] === 'tab b');
  check('a restored tab is marked whole', r.changed.get('b') === null);
  const live = [sh('a', {}), sh('p', { '0-0': 'partner tab' })];
  const r2 = mergeUndoStep(live, [sh('a', { '0-0': 'x' })], [sh('a', {})]);
  check("a tab a partner added isn't removed by undo", r2.sheets.some((s) => s.id === 'p'));
  const renamed = mergeUndoStep([sh('a', {}, { name: 'Case' })], [sh('a', {}, { name: 'Case' })], [sh('a', {}, { name: 'Adv 1' })]);
  check('undoing a rename restores the old name', renamed.sheets[0].name === 'Adv 1');
  const partnerRename = mergeUndoStep([sh('a', { '0-0': 'x' }, { name: 'Partner name' })], [sh('a', { '0-0': 'x' })], [sh('a', {})]);
  check("a partner's rename survives an unrelated undo", partnerRename.sheets[0].name === 'Partner name');
}

console.log('\n[5] rebasing keeps partner edits out of multi-step undo');
{
  // I make two edits; between them a partner types. Then I undo both.
  const s0 = [sh('a', {})];
  const s1 = [sh('a', { '0-0': 'one' })];
  const history = [clone(s0), clone(s1)].map((sheets) => ({ sheets }));
  rebaseCell(history, 'a', '5-5', 'partner');                          // arrives now
  history.push({ sheets: [sh('a', { '0-0': 'one', '1-0': 'two', '5-5': 'partner' })] });
  let live = clone(history[2].sheets);
  live = mergeUndoStep(live, history[2].sheets, history[1].sheets).sheets;
  live = mergeUndoStep(live, history[1].sheets, history[0].sheets).sheets;
  check('both of my edits are gone', !live[0].cells['0-0'] && !live[0].cells['1-0']);
  check("the partner's text is still there", live[0].cells['5-5'] === 'partner');
  rebaseArrows(history, 'a', [{ id: 'z' }]);
  check('rebaseArrows writes every snapshot', history.every((h) => (h.sheets[0].arrows ?? []).length === 1));
  rebaseCell(history, 'a', '5-5', '');
  check('a partner clearing a cell clears it everywhere', history.every((h) => !('5-5' in h.sheets[0].cells)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
