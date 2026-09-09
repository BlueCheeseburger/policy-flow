// Tests for the "you're typing a stock issue" rename suggestion.
//
// New policy flows default to the ADVANTAGE layout, so a stock-issues aff used to
// mean renaming three tabs by hand. These pin down when the offer appears, what
// it would rename, and — most importantly — when it must stay quiet.
//
// Run:  npx tsx scripts/test-stock-issue-suggest.ts

import {
  STOCK_ISSUES, matchStockIssue, isDefaultAdvantageTab, planStockIssueConversion,
} from '../src/lib/stockIssueSuggest';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}
const ADV = ['Adv 1', 'Adv 2', 'Adv 3', 'Off 1', 'Off 2', 'Off 3', 'Off 4'];

console.log('\n[1] matchStockIssue');
{
  check('three letters is enough', matchStockIssue('inh') === 'Inherency');
  check('case does not matter', matchStockIssue('HAR') === 'Harms');
  check('a full word matches', matchStockIssue('Solvency') === 'Solvency');
  check('trailing space is ignored', matchStockIssue('  harms ') === 'Harms');
  check('two letters is not enough', matchStockIssue('in') === null);
  check('empty is not a match', matchStockIssue('') === null);
  // The false positive that matters: an advantage aff has a solvency contention,
  // so "Solvency Deficit" is an ordinary advantage-flow tab name.
  check('a longer name past the word stops matching', matchStockIssue('Solvency Deficit') === null);
  check('an unrelated tab never matches', matchStockIssue('Politics DA') === null);
  check('a mid-word substring does not match', matchStockIssue('erency') === null);
}

console.log('\n[2] isDefaultAdvantageTab — only layout defaults are ever renamed');
{
  check('Adv N is a default', isDefaultAdvantageTab('Adv 1'));
  check('Advantage N is a default', isDefaultAdvantageTab('Advantage 2'));
  check('Contention N is a default', isDefaultAdvantageTab('Contention 1'));
  check('a real name is NOT a default', !isDefaultAdvantageTab('Heg Adv'));
  check('an off-case slot is not an advantage default', !isDefaultAdvantageTab('Off 3'));
  check('a stock issue is not a default', !isDefaultAdvantageTab('Inherency'));
}

console.log('\n[3] planStockIssueConversion');
{
  const p = planStockIssueConversion(ADV, 0, 'inh');
  check('it fires on the first tab', !!p);
  check('the typed tab gets what was typed', p!.names[0] === 'Inherency', String(p!.names[0]));
  check('the other default tabs are filled in order',
    p!.names[1] === 'Harms' && p!.names[2] === 'Solvency',
    p!.names.slice(0, 3).join('|'));
  check('off-case tabs are untouched', p!.names.slice(3).join('|') === 'Off 1|Off 2|Off 3|Off 4');
  check('every rename is reported', p!.renames.length === 3);

  // The user's own typing is never overridden — typing "Harms" into Adv 1 leaves
  // Harms on Adv 1, rather than positionally assigning Inherency there.
  const q = planStockIssueConversion(ADV, 0, 'Harms');
  check('typing out of canonical order keeps the typed tab in place',
    q!.names[0] === 'Harms', String(q!.names[0]));
  check('and the rest fill around it',
    q!.names[1] === 'Inherency' && q!.names[2] === 'Solvency',
    q!.names.slice(0, 3).join('|'));
}

console.log('\n[4] When it must stay quiet');
{
  check('a tab the user already named is not converted',
    planStockIssueConversion(['Heg Adv', 'Adv 2', 'Adv 3'], 0, 'inh') === null);
  check('nothing to gain — no OTHER default tab left',
    planStockIssueConversion(['Adv 1', 'Warming', 'Econ'], 0, 'inh') === null);
  check('a non-stock-issue name never offers',
    planStockIssueConversion(ADV, 0, 'Warming') === null);
  check('an out-of-range index is safe', planStockIssueConversion(ADV, 99, 'inh') === null);
  check('an empty flow is safe', planStockIssueConversion([], 0, 'inh') === null);
}

console.log('\n[5] No duplicate tab names');
{
  // "Harms" already exists, so it must not be written onto a second tab.
  const p = planStockIssueConversion(['Adv 1', 'Adv 2', 'Harms'], 0, 'inh');
  check('an existing stock issue is not duplicated',
    !!p && p.names.filter((n) => n === 'Harms').length === 1,
    p ? p.names.join('|') : 'null');
  check('the remaining one still fills', !!p && p.names[1] === 'Solvency', p ? p.names[1] : 'null');
  check('canonical list is unchanged', STOCK_ISSUES.join('|') === 'Inherency|Harms|Solvency');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
