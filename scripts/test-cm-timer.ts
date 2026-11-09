// Tests for lib/cmTimer.ts: CardMirror's timer mirrored into the flow.
//
// Run:  npx tsx scripts/test-cm-timer.ts

import {
  activeClock, clockMs, formatClock, parseTimeInput, parseTimerCmd, parseTimerMsg,
} from '../src/lib/cmTimer';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}
const MIN = 60_000;
const base = {
  mode: 'speech', running: false, speechMs: 8 * MIN, affPrepMs: 10 * MIN, negPrepMs: 7 * MIN,
  stopwatch: false, expiredMode: null, prepTotalMs: 10 * MIN, presets: [3, 6, 9],
};

console.log('\n[1] reading a state off the wire');
{
  const s = parseTimerMsg(base)!;
  check('a good state parses', !!s && s.speechMs === 8 * MIN && s.presets.join() === '3,6,9');
  check('an unknown mode is refused', parseTimerMsg({ ...base, mode: 'cx' }) === null);
  check('a missing clock is refused', parseTimerMsg({ ...base, negPrepMs: 'x' }) === null);
  check('negative time reads as zero', parseTimerMsg({ ...base, speechMs: -5 })!.speechMs === 0);
  check('junk presets are dropped', parseTimerMsg({ ...base, presets: [3, -1, 'x', 9e9, 6] })!.presets.join() === '3,6');
  check('not an object is refused', parseTimerMsg(null) === null && parseTimerMsg('x') === null);
}

console.log('\n[2] button presses');
{
  check('start, pause, reset', ['start', 'pause', 'reset'].every((a) => parseTimerCmd({ action: a })?.action === a));
  check('a mode switch needs a real mode', parseTimerCmd({ action: 'mode', mode: 'negPrep' })?.action === 'mode' && parseTimerCmd({ action: 'mode', mode: 'x' }) === null);
  check('a preset needs sane minutes', parseTimerCmd({ action: 'preset', minutes: 8 }) !== null && parseTimerCmd({ action: 'preset', minutes: 0 }) === null);
  check('a typed time is clamped at zero', (parseTimerCmd({ action: 'set', ms: -1 }) as any)?.ms === 0);
  check('anything else is refused', parseTimerCmd({ action: 'delete' }) === null);
}

console.log('\n[3] counting on this machine from when the state arrived');
{
  const run = parseTimerMsg({ ...base, running: true })!;
  check('a running countdown counts down', clockMs(run, 'speech', 1000, 31_000) === 8 * MIN - 30_000);
  check('the clocks that are not running hold still', clockMs(run, 'aff', 1000, 31_000) === 10 * MIN);
  check('a countdown stops at zero', clockMs(run, 'speech', 0, 99 * MIN) === 0);
  const sw = parseTimerMsg({ ...base, running: true, stopwatch: true, speechMs: 5000 })!;
  check('a stopwatch counts up', clockMs(sw, 'speech', 0, 2000) === 7000);
  const prep = parseTimerMsg({ ...base, mode: 'negPrep', running: true })!;
  check('a running prep clock counts down', clockMs(prep, 'neg', 0, MIN) === 6 * MIN);
  check('the display follows the mode', activeClock(prep) === 'neg' && activeClock(run) === 'speech');
  const paused = parseTimerMsg(base)!;
  check('a paused clock never moves', clockMs(paused, 'speech', 0, 10 * MIN) === 8 * MIN);
  check('a clock that arrived "in the future" does not run backwards', clockMs(run, 'speech', 5000, 1000) === 8 * MIN);
}

console.log('\n[4] showing and typing times');
{
  check('countdown rounds up', formatClock(59_001) === '1:00' && formatClock(0) === '0:00');
  check('count-up rounds down', formatClock(59_999, true) === '0:59');
  check('M:SS', parseTimeInput('8:00') === 8 * MIN && parseTimeInput('1:5') === 65_000);
  check('keypad digits', parseTimeInput('800') === 8 * MIN && parseTimeInput('90') === 90_000);
  check('nonsense', parseTimeInput('1:75') === null && parseTimeInput('abc') === null && parseTimeInput('') === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
