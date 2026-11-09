// Tests for Auto Flow's parse mode and the row rules it shares with CardMirror
// sends: lib/docOutline.ts, lib/autoFlowStructured.ts, lib/flowRowStyle.ts,
// and the double-underline emphasis in lib/cellHtml.ts.
//
// Run:  npx tsx scripts/test-auto-flow-structured.ts

import { JSDOM } from 'jsdom';

const dom = new JSDOM('');
(globalThis as any).DOMParser = dom.window.DOMParser;

const { extractOutline } = await import('../src/lib/docOutline');
const { parseStructuredFlow } = await import('../src/lib/autoFlowStructured');
const { layoutRows, headingHtml, INDENT_PX } = await import('../src/lib/flowRowStyle');
const { sanitizeCellHtml, cellHasEmphasis, setCellEmphasis, cleanPastedHtml } = await import('../src/lib/cellHtml');
const { itemsToCards, cardCellHtml, parseCardsMsg } = await import('../src/lib/cardMirrorLink');
const { pocketTabName } = await import('../src/lib/autoFlowParse');

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}

const p = (style: string, text: string) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
const body = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const doc = (...ps: string[]) => `<w:document><w:body>${ps.join('')}</w:body></w:document>`;
const LEVELS = new Map([['Heading1', 1], ['Heading2', 2], ['Heading3', 3], ['Heading4', 4], ['Analytic', 4]]);
const NOTES = { analytic: new Set(['Analytic']), undertag: new Set(['Undertag']) };
const COLS = ['1AC', '1NC', '2AC', '2NC/1NR', '1AR', '2NR', '2AR'];

console.log('\n[1] outline: levels, cites, analytics, undertags');
{
  const o = extractOutline(doc(
    p('Heading1', 'Stocks'), p('Heading2', 'Uniqueness'), p('Heading3', 'AT: Thumpers'),
    p('Undertag', 'old card, pair it'), p('Heading4', 'Stocks are up'), body('Smith 26 — Jo Smith, Reuters'), body('card text'),
    p('Analytic', 'No thumper outweighs'), p('Heading4', 'Label tag'), body('commentary with no year'),
  ), LEVELS, NOTES);
  check('kinds in order', o.map((x) => x.kind).join() === 'pocket,hat,block,tag,analytic,tag', o.map((x) => x.kind).join());
  check('tag gets its short cite', o[3].cite === 'Smith 26', String(o[3].cite));
  check('analytic is not a tag even when built on Heading 4', o[4].kind === 'analytic');
  check('a paragraph with no year is not a cite', !o[5].cite, String(o[5].cite));
  check('undertags and card text never appear', !o.some((x) => /old card|card text/.test(x.text)));
  const h1h3 = extractOutline(doc(p('Heading1', 'Stocks'), p('Heading3', 'AT: X'), p('Heading4', 'tag')), LEVELS, NOTES);
  check('a doc using H1 and H3 keeps blocks as blocks', h1h3[1].kind === 'block');
  const shallow = extractOutline(doc(p('Heading1', 'K'), p('Heading3', 'Their tag')), LEVELS, NOTES);
  check('the deepest heading used is the tag', shallow[1].kind === 'tag');
}

console.log('\n[2] tabs: pockets, speech labels, generic headers');
{
  check('a pocket naming a position is the tab', pocketTabName('Stocks') === 'Stocks');
  check('a speech-label pocket is not', pocketTabName('1NC') === null && pocketTabName('NSU Single Payer 1AC v3.2') === null);
  check('"Negative" is not a tab', pocketTabName('Negative') === null);

  const pocketDoc = { fileName: '2NC 10-9.docx', outline: [
    { kind: 'pocket', text: 'Stocks' }, { kind: 'hat', text: 'Link' }, { kind: 'block', text: 'AT: Buyout---2NC' },
    { kind: 'tag', text: 'No buyout', cite: 'Lee 25' }, { kind: 'analytic', text: 'They concede it' },
  ] as any };
  const r = parseStructuredFlow({ docs: [pocketDoc], columns: COLS, existingSheets: [], event: 'policy' });
  check('everything lands on the pocket tab, in the 2NC column', r.placements.every((x) => x.sheetName === 'Stocks' && x.column === '2NC/1NR'));
  check('hat and block are rows, in order, without the speech label',
    r.placements.map((x) => `${x.rowKind}:${x.tag}`).join('|') === 'hat:Link|block:AT: Buyout|card:No buyout|analytic:They concede it',
    r.placements.map((x) => `${x.rowKind}:${x.tag}`).join('|'));

  const offDoc = { fileName: '1NC.docx', outline: [
    { kind: 'pocket', text: '1NC' }, { kind: 'hat', text: 'OFF' },
    { kind: 'block', text: '1NC---OFF' }, { kind: 'tag', text: 'ECON DA.' }, { kind: 'tag', text: 'Link', cite: 'A 25' },
    { kind: 'block', text: '1NC---OFF' }, { kind: 'tag', text: 'STATES CP.' },
  ] as any };
  const r2 = parseStructuredFlow({ docs: [offDoc], columns: COLS, existingSheets: [], event: 'policy' });
  check('each generic "OFF" block is its own tab, named by its first tag',
    [...new Set(r2.placements.map((x) => x.sheetName))].join() === 'ECON DA,STATES CP');
  check('generic headers are never written as rows', !r2.placements.some((x) => x.rowKind === 'hat' || x.rowKind === 'block'));
  check('those rows are counted as unresolved', r2.unresolved === 3, String(r2.unresolved));
  check('and flagged, so Auto Flow holds them back for the user to place', r2.placements.every((x) => x.unresolved));
  check('each keeps the headings it sat under', r2.placements[0].context.block === '1NC---OFF' && r2.placements[0].context.pocket === '1NC');
  check('rows under one "OFF" share a group; the next "OFF" is another',
    r2.placements[0].group === r2.placements[1].group && r2.placements[1].group !== r2.placements[2].group);
  check('rows under a named position are not flagged', r.placements.every((x) => !x.unresolved));

  const affDoc = { fileName: '1AC.docx', outline: [
    { kind: 'pocket', text: '1AC' }, { kind: 'hat', text: 'Plan' },
    { kind: 'tag', text: 'The United States federal government should adopt single payer.' },
    { kind: 'hat', text: 'Advantage 1: Economy' }, { kind: 'block', text: 'Scenario 1 is Debt' }, { kind: 'tag', text: 'Debt bad' },
  ] as any };
  const r3 = parseStructuredFlow({ docs: [affDoc], columns: COLS, existingSheets: ['Case'], event: 'policy' });
  check('the plan is marked as the plan, on no tab of its own', r3.placements[0].isPlan && r3.placements[0].sheetName === '');
  check('"Advantage 1: Economy" names the tab and is not written', r3.placements[1].sheetName === 'Economy' && r3.placements[1].rowKind === 'block');
  const existing = parseStructuredFlow({ docs: [pocketDoc], columns: COLS, existingSheets: ['Stocks DA'], event: 'policy' });
  check('a matching tab already in the flow is reused', existing.placements.every((x) => x.sheetName === 'Stocks DA' && !x.isNewSheet));
  const noSpeech = parseStructuredFlow({ docs: [{ fileName: 'notes.docx', outline: [{ kind: 'tag', text: 'x' }] as any }], columns: COLS, existingSheets: [], event: 'policy' });
  check('a doc with no speech anywhere is skipped, with a reason', noSpeech.placements.length === 0 && noSpeech.skipped.length === 1);
  check('a skipped row keeps what the user needs to place it by hand',
    noSpeech.skipped[0].fileName === 'notes.docx' && noSpeech.skipped[0].tag === 'x' && noSpeech.skipped[0].rowKind === 'card');
}

console.log('\n[3] layout: buffers around hats, indents under hats and blocks');
{
  const R = (kind: any, html: string) => ({ kind, html });
  const out = layoutRows([R('hat', 'H'), R('block', 'B'), R('card', 'T'), R('analytic', 'A')], true);
  check('blank row above a hat when something is above it', out[0] === null && out[1] === 'H' && out[2] === null);
  check('block indented one step', out[3] === `<div style="padding-left: ${INDENT_PX}px">B</div>`, String(out[3]));
  check('tag under hat and block indented two steps', out[4] === `<div style="padding-left: ${2 * INDENT_PX}px">T</div>`, String(out[4]));
  const top = layoutRows([R('hat', 'H'), R('card', 'T')], false);
  check('no blank row above a hat at the top', top[0] === 'H' && top[1] === null && top.length === 3);
  const two = layoutRows([R('card', 'T'), R('hat', 'H1'), R('hat', 'H2')], false);
  check('two hats in a row share one gap, and a trailing gap is dropped', JSON.stringify(two) === JSON.stringify(['T', null, 'H1', null, 'H2']), JSON.stringify(two));
  const blockOnly = layoutRows([R('block', 'B'), R('card', 'T')], false);
  check('a block with no hat above is not indented; its tags are, once', blockOnly[0] === 'B' && blockOnly[1] === `<div style="padding-left: ${INDENT_PX}px">T</div>`);
  const reset = layoutRows([R('hat', 'H'), R('card', 'T'), R('pocket', ''), R('card', 'U')], false);
  check('a pocket ends the indent', reset[reset.length - 1] === 'U');
}

console.log('\n[4] double underline');
{
  const hat = headingHtml('hat', 'Midterms DA');
  check('a hat is double underlined', sanitizeCellHtml(hat).includes('underline double'), sanitizeCellHtml(hat));
  check('it reads as double, not single', cellHasEmphasis(hat, 'doubleUnderline') && !cellHasEmphasis(hat, 'underline'));
  const off = setCellEmphasis(hat, 'doubleUnderline', false);
  check('toggling it off removes it', !off.includes('double'), off);
  const on = setCellEmphasis('plain', 'doubleUnderline', true);
  check('toggling it on a whole cell', cellHasEmphasis(on, 'doubleUnderline'), on);
  check('single underline still works alongside', cellHasEmphasis('<u>x</u>', 'underline') && !cellHasEmphasis('<u>x</u>', 'doubleUnderline'));
  check('indent survives the sanitizer', sanitizeCellHtml('<div style="padding-left: 16px">x</div>').includes('padding-left: 16px'));
  check('odd padding values do not', !sanitizeCellHtml('<div style="padding-left: 3em">x</div>').includes('padding'));
  check('pasted padding is shed', !cleanPastedHtml('<div style="padding-left: 16px">x</div>').includes('padding'));
}

console.log('\n[5] CardMirror sends carry the heading level');
{
  const cards = itemsToCards([
    { kind: 'pocket', text: 'Stocks', source: '' }, { kind: 'hat', text: 'Link', source: '' },
    { kind: 'block', text: 'AT: Buyout', source: '' }, { kind: 'tag', text: 'No buyout', source: '' },
  ], { includeHeadings: true });
  check('each heading keeps its level', cards.slice(0, 3).map((c) => c.level).join() === 'pocket,hat,block');
  check('a hat renders double underlined', cardCellHtml(cards[1]).includes('underline double'));
  check('a block renders single underlined', cardCellHtml(cards[2]).startsWith('<u>'));
  const old = parseCardsMsg({ id: 'x', cards: [{ kind: 'heading', text: 'Old' }] })!;
  check('a heading from an older plugin has no level (drawn as a block)', old.cards[0].level === undefined && cardCellHtml(old.cards[0]).startsWith('<u>'));
  const bad = parseCardsMsg({ id: 'x', cards: [{ kind: 'heading', level: 'evil', text: 'X' }] })!;
  check('an unknown level is dropped', bad.cards[0].level === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
