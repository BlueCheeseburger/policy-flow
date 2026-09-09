// Whole-cell emphasis — what the toolbar's B/I/U/S/H do to a SELECTION, where
// there is no caret to run execCommand against.
//
// The load-bearing oddity: flow cells are BOLD BY DEFAULT (`.flow-cell` in
// index.css), so bold is the absence of markup and "not bold" is the state that
// has to be written down. Every other emphasis works the normal way round.
//
// Run:  npx tsx scripts/test-cell-emphasis.ts

import { JSDOM } from 'jsdom';

const dom = new JSDOM('');
(globalThis as any).DOMParser = dom.window.DOMParser;

const { cellHasEmphasis, setCellEmphasis } = await import('../src/lib/cellHtml');

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}
const hasText = (h: string) => /\S/.test(h.replace(/<[^>]*>/g, ''));

console.log('\n[1] Bold is the baseline');
{
  check('plain text is already bold', cellHasEmphasis('Warming turns the case', 'bold'));
  check('explicitly normal text is not', !cellHasEmphasis('<span style="font-weight: normal">cite</span>', 'bold'));
  check('a <b> is bold', cellHasEmphasis('<b>tag</b>', 'bold'));
  check('font-weight: 700 is bold', cellHasEmphasis('<span style="font-weight: 700">x</span>', 'bold'));
  check('font-weight: 400 is not', !cellHasEmphasis('<span style="font-weight: 400">x</span>', 'bold'));
  // Half a cell in normal weight is not a bold cell — the toolbar button must
  // not claim the whole selection is bold when part of it isn't.
  check('a partly-normal cell does not count as bold',
    !cellHasEmphasis('tag <span style="font-weight: normal">cite</span>', 'bold'));
  check('an empty cell reports the baseline', cellHasEmphasis('', 'bold'));
}

console.log('\n[2] Turning bold off, and back on');
{
  const off = setCellEmphasis('Nuclear war', 'bold', false);
  check('un-bolding writes an explicit normal weight', /font-weight:\s*normal/.test(off));
  check('and the text survives', off.includes('Nuclear war'));
  check('the result reads as not-bold', !cellHasEmphasis(off, 'bold'));

  const backOn = setCellEmphasis(off, 'bold', true);
  check('re-bolding drops the marker again', !/font-weight/.test(backOn));
  check('and reads as bold', cellHasEmphasis(backOn, 'bold'));
  check('the text is still there', backOn.includes('Nuclear war'));
  // Toggling twice must land back on clean markup, not an accumulating pile.
  check('a round trip leaves no residue', backOn === 'Nuclear war');
}

console.log('\n[3] The other emphases work the normal way round');
{
  for (const [e, probe] of [['italic', '<i>'], ['underline', '<u>'], ['strikeThrough', '<s>']] as const) {
    check(`${e} starts off`, !cellHasEmphasis('plain', e));
    const on = setCellEmphasis('plain', e, true);
    check(`${e} on wraps the cell`, on.startsWith(probe) && cellHasEmphasis(on, e));
    const off = setCellEmphasis(on, e, false);
    check(`${e} off unwraps it cleanly`, off === 'plain');
  }
  const hl = setCellEmphasis('impact', 'highlight', true);
  check('highlight paints a background', /background-color/.test(hl) && cellHasEmphasis(hl, 'highlight'));
  check('and removing it comes back clean', setCellEmphasis(hl, 'highlight', false) === 'impact');
}

console.log('\n[4] One emphasis never disturbs another');
{
  const start = '<i>Smith 24</i>';
  const bolded = setCellEmphasis(start, 'bold', false);
  check('un-bolding keeps the italic', cellHasEmphasis(bolded, 'italic'));
  check('and applies the un-bold', !cellHasEmphasis(bolded, 'bold'));

  const both = setCellEmphasis(setCellEmphasis('x', 'underline', true), 'strikeThrough', true);
  check('underline survives adding strike', cellHasEmphasis(both, 'underline'));
  check('strike survives too', cellHasEmphasis(both, 'strikeThrough'));
  // Both live on text-decoration, so a naive strip would take the other with it.
  const justUnderline = setCellEmphasis(both, 'strikeThrough', false);
  check('removing strike leaves underline alone', cellHasEmphasis(justUnderline, 'underline'));
  check('and strike is genuinely gone', !cellHasEmphasis(justUnderline, 'strikeThrough'));
}

console.log('\n[5] Messier input');
{
  // Nested and contradictory markup from an older cell or a paste.
  const messy = '<b><span style="font-weight: normal">a</span></b>';
  check('the innermost rule wins', !cellHasEmphasis(messy, 'bold'));
  const fixed = setCellEmphasis(messy, 'bold', true);
  check('normalizing collapses the contradiction', !/font-weight/.test(fixed) && fixed.includes('a'));

  check('a cell with only markup is left alone', setCellEmphasis('<br>', 'italic', true) === '<br>');
  check('an empty cell is left alone', setCellEmphasis('', 'bold', false) === '');
  check('whitespace-only is left alone', !hasText(setCellEmphasis('   ', 'underline', true)));

  // A tag + cite cell, the commonest shape on a flow.
  const card = 'Warming is real<br><span style="font-weight: normal">Smith 24</span>';
  check('a tag/cite cell is not uniformly bold', !cellHasEmphasis(card, 'bold'));
  const allBold = setCellEmphasis(card, 'bold', true);
  check('bolding the whole cell removes the cite exception', cellHasEmphasis(allBold, 'bold'));
  check('and keeps the line break', allBold.includes('<br>'));
  check('and keeps both pieces of text', allBold.includes('Warming is real') && allBold.includes('Smith 24'));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
