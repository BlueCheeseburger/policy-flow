// What the AI tab-summary tooltip is allowed to read: which tabs qualify at all,
// and which single speech column the summary sees.
//
// Run:  npx tsx scripts/test-flow-tab-summary.ts

import {
  wasAutoFlowed, summaryColumnFor, summaryEntries, summarySignature,
} from '../src/lib/flowTabSummary';

const POLICY = ['1AC', '1NC', '2AC', '2NC/1NR', '1AR', '2NR', '2AR'];
const PF_PRO = ['Pro Case', 'Con Case', 'Con Rebuttal', 'Pro Rebuttal', 'Pro Summary', 'Con Summary', 'Pro FF', 'Con FF'];
const PF_CON = ['Con Case', 'Pro Case', 'Pro Rebuttal', 'Con Rebuttal', 'Con Summary', 'Pro Summary', 'Con FF', 'Pro FF'];

// The lib takes a text extractor so it needs no DOM; strip tags crudely here.
const toText = (html: string) => html.replace(/<[^>]*>/g, '');

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}

console.log('\n[1] Only Auto Flow\'s own tabs are eligible');
{
  check('a tab Auto Flow classified qualifies', wasAutoFlowed({ autoFlowRole: 'advantage' }));
  check('an off-case tab qualifies', wasAutoFlowed({ autoFlowRole: 'offcase' }));
  // Auto Flow wrote here but couldn't tell what it was. Still its work.
  check('an unclassified auto-flowed tab still qualifies', wasAutoFlowed({ autoFlowRole: null }));
  // The whole point: a tab the debater typed themselves gets no AI call.
  check('a hand-typed tab does NOT qualify', !wasAutoFlowed({}));
  check('a missing sheet does not qualify', !wasAutoFlowed(null) && !wasAutoFlowed(undefined));
  // Legacy: sheets written before autoFlowRole existed carry aiCells, which
  // only Auto Flow ever sets — without this they'd silently lose the feature.
  check('a legacy auto-flowed tab qualifies via aiCells', wasAutoFlowed({ aiCells: ['0-0'] }));
  check('but an empty aiCells list is not a marker', !wasAutoFlowed({ aiCells: [] }));
}

console.log('\n[2] Policy: an advantage reads the 1AC, an off-case reads the 1NC');
{
  check('advantage → 1AC', summaryColumnFor('advantage', POLICY, 'policy') === 0);
  check('offcase → 1NC', summaryColumnFor('offcase', POLICY, 'policy') === 1);
  // An unclassified tab has no honest column to pick, so it reads everything —
  // the old behavior, which beats guessing aff/neg wrong.
  check('an unclassified tab reads the whole sheet', summaryColumnFor(null, POLICY, 'policy') === null);
  check('so does one with no role at all', summaryColumnFor(undefined, POLICY, 'policy') === null);
}

console.log('\n[3] Renamed and reordered columns resolve by name, not position');
{
  const renamed = ['Plan', '1NC', '1AC', '2AC'];
  check('finds the 1AC wherever it sits', summaryColumnFor('advantage', renamed, 'policy') === 2);
  check('finds the 1NC wherever it sits', summaryColumnFor('offcase', renamed, 'policy') === 1);
  // Spacing/case shouldn't matter.
  check('tolerates spacing and case', summaryColumnFor('advantage', ['1 ac', '1 nc'], 'policy') === 0);
  // Fully custom columns: fall back to position rather than giving up.
  const custom = ['Aff', 'Neg', 'Aff 2'];
  check('falls back to the first column for an advantage', summaryColumnFor('advantage', custom, 'policy') === 0);
  check('falls back to the second for an off-case', summaryColumnFor('offcase', custom, 'policy') === 1);
  // A one-column flow has no 1NC to fall back to.
  check('refuses a fallback that does not exist', summaryColumnFor('offcase', ['Only'], 'policy') === null);
  check('empty columns yield nothing', summaryColumnFor('advantage', [], 'policy') === null);
}

console.log('\n[4] PF: the two case columns, in speech order');
{
  check('pro-first: contention → Pro Case', summaryColumnFor('advantage', PF_PRO, 'pf') === 0);
  check('pro-first: off → Con Case', summaryColumnFor('offcase', PF_PRO, 'pf') === 1);
  // Con-first flips who speaks first, and the column array is ordered by speech,
  // so the same rule lands on the right side without a special case.
  check('con-first: contention → Con Case', summaryColumnFor('advantage', PF_CON, 'pf') === 0);
  check('con-first: off → Pro Case', summaryColumnFor('offcase', PF_CON, 'pf') === 1);
  check('a rebuttal column is never picked', summaryColumnFor('offcase', PF_PRO, 'pf') !== 2);
}

console.log('\n[5] Entries come from that column only, in reading order');
{
  const cells: Record<string, string> = {
    '0-0': '<b>Econ collapse</b><br>Smith 24',
    '2-0': 'Trade war impact',
    '1-0': 'Recession now',
    '0-1': 'NEG ANSWER — non-unique',
    '3-2': 'AFF EXTENSION',
  };
  const only1ac = summaryEntries(cells, 0, toText);
  check('reads just the one column', only1ac.length === 3);
  check('in top-to-bottom order', only1ac[0].startsWith('Econ collapse') && only1ac[1] === 'Recession now' && only1ac[2] === 'Trade war impact');
  check('the answer column is excluded', !only1ac.some((e) => e.includes('NEG ANSWER')));
  check('and so are later speeches', !only1ac.some((e) => e.includes('EXTENSION')));
  check('markup is stripped', only1ac[0] === 'Econ collapseSmith 24');

  check('null column reads everything', summaryEntries(cells, null, toText).length === 5);
  check('an empty column yields nothing', summaryEntries(cells, 5, toText).length === 0);
  check('blank cells are dropped', summaryEntries({ '0-0': '   ', '1-0': 'real' }, 0, toText).length === 1);
  check('no cells is not a crash', summaryEntries({}, 0, toText).length === 0);
}

console.log('\n[6] The cache signature tracks only what was sent');
{
  const a = summarySignature(['one', 'two']);
  check('the same entries sign the same', a === summarySignature(['one', 'two']));
  check('changed text re-signs', a !== summarySignature(['one', 'three']));
  check('order matters', a !== summarySignature(['two', 'one']));
  check('a dropped entry re-signs', a !== summarySignature(['one']));
  check('nothing signs stably', summarySignature([]) === summarySignature([]));

  // The point of signing the ENTRIES rather than the sheet: typing an answer
  // into the 2AC must not invalidate a summary built from the 1AC, or every
  // answer flowed mid-round would spend another AI call for the same sentence.
  const cells: Record<string, string> = { '0-0': 'the position' };
  const before = summarySignature(summaryEntries(cells, 0, toText));
  const after = summarySignature(summaryEntries({ ...cells, '0-2': 'an answer' }, 0, toText));
  check('an answer in a later speech does not invalidate the summary', before === after);
}

console.log(fail === 0 ? `\n✅ ${pass} passed, 0 failed` : `\n❌ ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
