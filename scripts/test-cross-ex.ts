// Tests for the cross-ex doc's outline model (src/lib/crossEx.ts): bullets and
// sub-bullets only, a stable text round-trip (it's a Y.Text in a live room, so
// parse → serialize must not rewrite what a partner typed), and paste cleanup.
//
// Run:  npx tsx scripts/test-cross-ex.ts

import { parseCx, serializeCx, normalizeCx, pastedToBullets, cxToPlainText } from '../src/lib/crossEx';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}
const J = (x: unknown) => JSON.stringify(x);

console.log('\n[1] parse / serialize');
{
  check('empty doc is one empty bullet', J(parseCx('')) === J([{ level: 0, text: '' }]));
  const src = 'Why no solvency?\n\tSaid funding is enough\n\tConceded no card\nWhat is the plan text?';
  const b = parseCx(src);
  check('levels read from the leading tab', J(b.map((x) => x.level)) === J([0, 1, 1, 0]));
  check('round-trip is exact', serializeCx(b) === src, serializeCx(b));
  check('first bullet can never be a sub-point', parseCx('\tanswer first')[0].level === 0);
  check('only two levels: deeper tabs flatten', parseCx('q\n\t\tdeep')[1].level === 1 && parseCx('q\n\t\tdeep')[1].text === ' deep');
  check('CR in text never survives', !serializeCx([{ level: 0, text: 'a\rb' }]).includes('\r'));
  check('normalize never returns empty', normalizeCx([]).length === 1);
  check('empty lines stay (a bullet being typed)', parseCx('a\n\nb').length === 3);
}

console.log('\n[2] paste');
{
  const docs = '• Why no solvency?\n    ◦ Funding is enough\n    ◦ No card\n• Plan text?';
  const p = pastedToBullets(docs);
  check('bullet glyphs stripped', p[0].text === 'Why no solvency?' && p[1].text === 'Funding is enough', J(p));
  check('indent → sub-point', J(p.map((x) => x.level)) === J([0, 1, 1, 0]));
  const md = '- one\n  - two\n    - three\n- four';
  check('markdown: any deeper indent is a sub-point', J(pastedToBullets(md).map((x) => x.level)) === J([0, 1, 1, 0]));
  const nums = '1. First\n2) Second\na. third\n(3) fourth';
  check('numbering stripped', J(pastedToBullets(nums).map((x) => x.text)) === J(['First', 'Second', 'third', 'fourth']));
  check('blank lines dropped', pastedToBullets('a\n\n\nb').length === 2);
  check('uniformly indented paste stays top-level', pastedToBullets('    a\n    b').every((x) => x.level === 0));
  check('words starting with a letter+dot are kept', pastedToBullets('e.g. this')[0].text === 'e.g. this');
  check('CRLF handled', pastedToBullets('a\r\nb').length === 2);
  check('checkboxes stripped', pastedToBullets('- [ ] todo')[0].text === 'todo');
}

console.log('\n[3] copy out');
{
  const t = cxToPlainText(parseCx('Q\n\tA\n\n'));
  check('plain text uses bullets and skips blanks', t === '• Q\n    ◦ A', J(t));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
