// Tests for the CardMirror plugin ↔ flow tab protocol (src/lib/cardMirrorLink.ts)
// and the cell-sanitizer rule that keeps a sent row's source link alive.
//
// What these pin down:
//  - A hat/block/pocket send turns CardMirror's flat extraction into one row
//    per card, each with its OWN cite — never a neighbour's, never a quals line.
//  - The source token survives cardCellHtml → sanitizeCellHtml (right-click
//    reads it back), and nothing else that looks like it does: a forged
//    attribute value, the attribute on the wrong tag, markup in the text.
//  - Malformed wire messages are rejected, not half-applied.
//
// Run:  npx tsx scripts/test-cardmirror-link.ts

import { JSDOM } from 'jsdom';

const dom = new JSDOM('');
(globalThis as any).DOMParser = dom.window.DOMParser;

const { itemsToCards, cardCellHtml, chunkCards, parseCardsMsg, isCmSource, sha256Hex, cmTopic } = await import('../src/lib/cardMirrorLink');
const { sanitizeCellHtml, htmlToText, cleanPastedHtml } = await import('../src/lib/cellHtml');

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}

const SRC = (n: number) => `cmsrc1.eyJkb2NJZCI6ImQi${n}fQ`;

console.log('\n[1] itemsToCards');
{
  const items = [
    { kind: 'hat' as const, text: 'Advantage 1 — Economy', source: SRC(1) },
    { kind: 'tag' as const, text: 'Recession coming now', source: SRC(2) },
    { kind: 'cite' as const, text: 'Smith 24', source: SRC(2) },
    { kind: 'cite' as const, text: 'Professor of Economics at Yale', source: SRC(2) },
    { kind: 'undertag' as const, text: 'this card is great', source: SRC(2) },
    { kind: 'analytic' as const, text: 'Their ev is old', source: SRC(3) },
    { kind: 'block' as const, text: 'AT: Cap K', source: SRC(4) },
    { kind: 'cite' as const, text: 'Stray 19', source: SRC(4) },
    { kind: 'tag' as const, text: '  Perm   do both  ', source: SRC(5) },
    { kind: 'cite' as const, text: 'Jones 23', source: SRC(5) },
  ];
  const cards = itemsToCards(items, { includeHeadings: true });
  check('one row per heading and card', cards.length === 5, JSON.stringify(cards.map((c) => c.text)));
  check('hat becomes a heading row', cards[0].kind === 'heading' && cards[0].text === 'Advantage 1 — Economy');
  check('card takes its first cite', cards[1].cite === 'Smith 24');
  check('a second cite (quals) does not replace it', cards[1].cite === 'Smith 24');
  check('analytic with no cite has none', cards[2].kind === 'card' && cards[2].cite === undefined);
  check("an analytic never inherits the previous card's cite", cards[2].cite !== 'Smith 24');
  check('a cite after a heading attaches to nothing', !cards.some((c) => c.cite === 'Stray 19'));
  check('text is trimmed', cards[4].text === 'Perm   do both');
  check('each row keeps its own source', cards[1].source === SRC(2) && cards[4].source === SRC(5));
  check('undertags never become rows', !cards.some((c) => c.text.includes('great')));
  const noHeads = itemsToCards(items, { includeHeadings: false });
  check('includeHeadings:false drops heading rows', noHeads.length === 3 && noHeads.every((c) => c.kind === 'card'));
  check('a bad source token is dropped, not forwarded', itemsToCards([{ kind: 'tag', text: 'x', source: 'javascript:alert(1)' }], { includeHeadings: true })[0].source === undefined);
  check('empty extraction → no rows', itemsToCards([], { includeHeadings: true }).length === 0);
}

console.log('\n[2] cardCellHtml → sanitizeCellHtml keeps the link');
{
  const html = sanitizeCellHtml(cardCellHtml({ kind: 'card', text: 'Tag <b>x</b> & y', cite: 'Smith 24', source: SRC(9) }));
  check('source survives the sanitizer', html.includes(`data-cm="${SRC(9)}"`), html);
  check('text with markup stays text', htmlToText(html) === 'Tag <b>x</b> & y — Smith 24', htmlToText(html));
  check('no <b> element smuggled in', !/<b>/.test(html));
  const head = sanitizeCellHtml(cardCellHtml({ kind: 'heading', text: 'AT: Cap K', source: SRC(4) }));
  check('heading is underlined and linked', head.startsWith('<u><span data-cm=') && head.endsWith('</span></u>'), head);
  const plain = sanitizeCellHtml(cardCellHtml({ kind: 'card', text: 'No source' }));
  check('no source → no attribute', !plain.includes('data-cm'), plain);
}

console.log('\n[3] sanitizer only keeps real tokens, only on spans');
{
  const forged = sanitizeCellHtml('<span data-cm="javascript:alert(1)">x</span>');
  check('non-token value is stripped', !forged.includes('data-cm'), forged);
  const quote = sanitizeCellHtml(`<span data-cm='cmsrc1.abc" onclick="x'>x</span>`);
  check('attribute breakout is stripped', !quote.includes('onclick') && !quote.includes('data-cm'), quote);
  const onDiv = sanitizeCellHtml(`<div data-cm="${SRC(1)}">x</div>`);
  check('token on a div is stripped', !onDiv.includes('data-cm'), onDiv);
  const withStyle = sanitizeCellHtml(`<span style="font-weight: normal" data-cm="${SRC(1)}">x</span>`);
  check('style and token coexist', withStyle === `<span style="font-weight: normal" data-cm="${SRC(1)}">x</span>`, withStyle);
  const pasted = cleanPastedHtml(`<span data-cm="${SRC(7)}">copied row</span>`, 'copied row');
  check('copy/paste between cells keeps the link', pasted.includes(`data-cm="${SRC(7)}"`), pasted);
  const other = sanitizeCellHtml('<span data-foo="1" id="y" class="z">x</span>');
  check('other attributes are still stripped', other === '<span>x</span>', other);
}

console.log('\n[4] parseCardsMsg');
{
  check('valid message parses', parseCardsMsg({ id: 'a', cards: [{ kind: 'card', text: 't', cite: 'c', source: SRC(1) }] })?.cards.length === 1);
  check('missing id rejected', parseCardsMsg({ cards: [{ kind: 'card', text: 't' }] }) === null);
  check('empty cards rejected', parseCardsMsg({ id: 'a', cards: [] }) === null);
  check('unknown kind rejects the whole batch', parseCardsMsg({ id: 'a', cards: [{ kind: 'card', text: 'ok' }, { kind: 'script', text: 'x' }] }) === null);
  check('blank text rejected', parseCardsMsg({ id: 'a', cards: [{ kind: 'card', text: '   ' }] }) === null);
  const m = parseCardsMsg({ id: 'a', cards: [{ kind: 'card', text: 't', source: 'not-a-token', extra: 1 }] });
  check('bad source dropped, extra fields dropped', !!m && m.cards[0].source === undefined && !('extra' in m.cards[0]));
  check('null rejected', parseCardsMsg(null) === null);
  check('oversized batch rejected', parseCardsMsg({ id: 'a', cards: Array.from({ length: 501 }, () => ({ kind: 'card', text: 't' })) }) === null);
}

console.log('\n[5] chunkCards');
{
  const many = Array.from({ length: 200 }, (_, i) => ({ kind: 'card' as const, text: `card ${i}` }));
  const chunks = chunkCards(many);
  check('splits by count', chunks.length === 3 && chunks[0].length === 80);
  check('keeps order', chunks.flat().every((c, i) => c.text === `card ${i}`));
  const big = Array.from({ length: 10 }, () => ({ kind: 'card' as const, text: 'x'.repeat(30_000) }));
  check('splits by size', chunkCards(big).every((c) => JSON.stringify(c).length < 100_000));
  check('one oversized card still goes alone', chunkCards([{ kind: 'card', text: 'y'.repeat(200_000) }]).length === 1);
}

console.log('\n[6] tokens and topics');
{
  check('real token shape accepted', isCmSource('cmsrc1.eyJkb2NJZCI6IjEyMyJ9'));
  check('future prefix accepted', isCmSource('cmsrc2.abc'));
  check('padding / spaces rejected', !isCmSource('cmsrc1.abc=') && !isCmSource('cmsrc1.a b'));
  // Must match the Edge Functions' hashToken and pf_api_tokens.token_hash.
  const h = await sha256Hex('abc');
  check('sha256Hex matches the known digest', h === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', h);
  check('topic is namespaced', cmTopic(h) === `pf:cm:${h}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
