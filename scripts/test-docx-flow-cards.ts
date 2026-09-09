// Exercises extractFlowCardsFromXml's heading-collapse logic against synthetic
// document.xml fragments covering the canonical 4-level Verbatim structure, the
// skipped-level cases DEBATE_DOC_STRUCTURE.md warns about (H1→H4 with no H2/H3),
// and edge cases (bare tags, multiple pockets, no headings at all).
//
// Run:  npx tsx scripts/test-docx-flow-cards.ts

import { extractFlowCardsFromXml } from '../src/lib/docxFlowCards';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}

// Minimal fake OOXML: a heading paragraph (styled) or a body paragraph (Normal).
function h(style: string, text: string) {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}
function body(text: string) {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}
function doc(...paras: string[]) {
  return `<w:document><w:body>${paras.join('')}</w:body></w:document>`;
}

const CANONICAL = new Map([['Heading1', 1], ['Heading2', 2], ['Heading3', 3], ['Heading4', 4]]);

console.log('\n[1] Canonical 4-level doc (pocket/hat/block/tag all present)');
{
  const xml = doc(
    h('Heading1', '1AC'),
    h('Heading2', 'Redundancy Advantage'),
    h('Heading3', 'Uniqueness'),
    h('Heading4', 'Reproductive healthcare is under attack'),
    body('NIRH 25'),
    h('Heading4', 'Perm do both'),
    body('Debaters 24'),
  );
  const cards = extractFlowCardsFromXml(xml, CANONICAL);
  check('two cards found', cards.length === 2, String(cards.length));
  check('pocket resolved', cards[0].pocket === '1AC', JSON.stringify(cards[0]));
  check('hat resolved', cards[0].hat === 'Redundancy Advantage');
  check('block resolved', cards[0].block === 'Uniqueness');
  check('tag resolved', cards[0].tag === 'Reproductive healthcare is under attack');
  check('cite resolved', cards[0].cite === 'NIRH 25');
  check('second card inherits same ancestors', cards[1].pocket === '1AC' && cards[1].hat === 'Redundancy Advantage' && cards[1].block === 'Uniqueness');
}

console.log('\n[2] Skipped levels: H1 straight to H4 (no H2/H3 used anywhere)');
{
  const xml = doc(
    h('Heading1', '1AC'),
    h('Heading4', 'Warming causes extinction'),
    body('Torres 22'),
  );
  const cards = extractFlowCardsFromXml(xml, CANONICAL);
  check('one card found', cards.length === 1);
  // Only ONE ancestor level is present (H1), so it collapses to "pocket", not "block".
  check('sole ancestor level becomes pocket, not block', cards[0].pocket === '1AC' && cards[0].hat === null && cards[0].block === null, JSON.stringify(cards[0]));
}

console.log('\n[3] Skipped levels: H1 and H3 used, H2/H4 never used (3 distinct levels)');
{
  const xml = doc(
    h('Heading1', '1NC'),
    h('Heading3', 'Politics DA'), // deepest present among ancestors → treated as "hat" (2nd of 2 ancestor slots)
    h('Heading4', 'Uniqueness — Trump has capital now'),
    body('WaPo 25'),
  );
  const cards = extractFlowCardsFromXml(xml, CANONICAL);
  check('one card found', cards.length === 1);
  check('two ancestor levels → pocket + hat, no block', cards[0].pocket === '1NC' && cards[0].hat === 'Politics DA' && cards[0].block === null, JSON.stringify(cards[0]));
}

console.log('\n[4] Bare tag with no cite underneath is dropped (analytic/label, not a card)');
{
  const xml = doc(
    h('Heading1', '1AC'),
    h('Heading4', 'Advantage 1 is Reproductive Rights'), // label tag, immediately followed by another heading
    h('Heading4', 'The impact is preventable death'),
    body('Wright 17'),
  );
  const cards = extractFlowCardsFromXml(xml, CANONICAL);
  check('label tag dropped, only the real card kept', cards.length === 1, JSON.stringify(cards));
  check('kept card is the one with a cite', cards[0]?.tag === 'The impact is preventable death');
}

console.log('\n[5] Multiple pockets reset hat/block underneath them');
{
  const xml = doc(
    h('Heading1', '1AC'),
    h('Heading2', 'Adv 1'),
    h('Heading4', 'Tag A'), body('Cite A'),
    h('Heading1', '2NC'), // new pocket — must clear the stale "Adv 1" hat
    h('Heading4', 'Tag B'), body('Cite B'),
  );
  const cards = extractFlowCardsFromXml(xml, CANONICAL);
  check('two cards found', cards.length === 2);
  check('first card has the Adv 1 hat', cards[0].hat === 'Adv 1');
  check('second card does NOT inherit the stale hat from the old pocket', cards[1].pocket === '2NC' && cards[1].hat === null, JSON.stringify(cards[1]));
}

console.log('\n[6] No headings at all → no cards, never throws');
{
  const xml = doc(body('just a paragraph'), body('another one'));
  const cards = extractFlowCardsFromXml(xml, CANONICAL);
  check('empty result', cards.length === 0);
}

console.log('\n[7] Non-standard heading style ids (resolved map, not literal Heading1-4)');
{
  const custom = new Map([['MyPocketStyle', 1], ['MyTagStyle', 2]]);
  const xml = doc(
    h('MyPocketStyle', '1AR'),
    h('MyTagStyle', 'Extend solvency'),
    body('Donovan 17'),
  );
  const cards = extractFlowCardsFromXml(xml, custom);
  check('resolves via the passed-in map, not hardcoded ids', cards.length === 1 && cards[0].pocket === '1AR' && cards[0].tag === 'Extend solvency', JSON.stringify(cards));
}

console.log('\n[8] Only the cite (first paragraph after a tag) is read — body paragraphs are ignored');
{
  const xml = doc(
    h('Heading1', '1AC'),
    h('Heading4', 'Tag'),
    body('This is the cite'),
    body('This is card body text that must never appear anywhere in the output'),
  );
  const cards = extractFlowCardsFromXml(xml, CANONICAL);
  check('cite is exactly the first paragraph, nothing more', cards[0]?.cite === 'This is the cite', JSON.stringify(cards[0]));
  check('body text never leaks into any field', !JSON.stringify(cards).includes('must never appear'));
}

console.log('\n[9] More than 3 ancestor levels (rare): closest two to tag are hat/block, rest collapse to pocket');
{
  const FIVE = new Map([['H1', 1], ['H2', 2], ['H3', 3], ['H4', 4], ['H5', 5]]);
  const xml = doc(
    h('H1', 'Neg'),
    h('H2', 'Off Case'),
    h('H3', 'Politics DA'),
    h('H4', 'Link'),
    h('H5', 'Tag text'),
    body('Cite text'),
  );
  const cards = extractFlowCardsFromXml(xml, FIVE);
  check('one card found', cards.length === 1);
  check('closest ancestor becomes block', cards[0]?.block === 'Link', JSON.stringify(cards[0]));
  check('second-closest becomes hat', cards[0]?.hat === 'Politics DA', JSON.stringify(cards[0]));
  // The two shallowest (Neg, Off Case) both collapse into pocket — last one wins.
  check('excess shallow levels collapse into pocket (most recent wins)', cards[0]?.pocket === 'Off Case', JSON.stringify(cards[0]));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
