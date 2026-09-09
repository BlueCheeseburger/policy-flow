// Regression tests for Auto Flow's classify batching.
//
// The bug these pin down: classify used to send every card in one prompt,
// truncated with `JSON.stringify(docs).slice(0, 60000)`. A real case packet is
// hundreds of cards (a single 1AC measured at 778), so the JSON was cut
// mid-object — most cards never sent, and what was sent malformed. The reply
// then hit the output-token cap, came back cut off, failed to parse, and was
// swallowed into `{ ok: true, placements: [] }`. The user saw a multi-minute
// wait end in "Warroom AI didn't propose any placements" with no error at all.
//
// Batching replaces the truncation. These tests pin the properties that make a
// chunked run equivalent to the (impossible) single-call run: nothing is lost,
// document order survives, and sheet naming stays coherent across batches.
//
// Run:  npx tsx scripts/test-auto-flow-batch.ts

import {
  flattenDocs, regroupBatch, chunkCards, mergeSheetNames, normalizePlacements,
  FlatFlowCard, DocGroup,
} from '../src/lib/autoFlowBatch';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}

// A realistic Verbatim cite, so the shortCite fallback has something to work on.
const card = (tag: string, pocket = '1AC'): any =>
  ({ pocket, hat: null, block: null, tag, cite: `${tag} Smith '24 [Jane; March; Professor of Things]` });

const docs: DocGroup[] = [
  { fileName: 'AFF.docx', cards: [card('heg 1'), card('heg 2'), card('econ 1')] },
  { fileName: '1NC.docx', cards: [card('politics uq', '1NC'), card('cap link', '1NC')] },
];

console.log('\n[1] flattenDocs — preserves document order across files');
{
  const flat = flattenDocs(docs);
  check('every card survives', flat.length === 5, `got ${flat.length}`);
  check('order is doc order', flat.map((f) => f.card.tag).join('|') === 'heg 1|heg 2|econ 1|politics uq|cap link');
  check('fileName travels with each card', flat[3].fileName === '1NC.docx');
  check('empty input is empty, not a crash', flattenDocs([]).length === 0);
  check('a doc with no cards contributes nothing', flattenDocs([{ fileName: 'x', cards: [] }]).length === 0);
}

console.log('\n[2] chunkCards — no card is lost or duplicated at any batch size');
{
  const flat = flattenDocs(docs);
  for (const size of [1, 2, 3, 4, 5, 10]) {
    const batches = chunkCards(flat, size);
    const rejoined = batches.flat().map((f) => f.card.tag).join('|');
    check(`size ${size}: round-trips to the same ordered list`,
      rejoined === flat.map((f) => f.card.tag).join('|'), rejoined);
    check(`size ${size}: no batch exceeds the size`, batches.every((b) => b.length <= size));
  }
  check('a size of 0 does not hang or produce empty batches',
    chunkCards(flat, 0).length === 5 && chunkCards(flat, 0).every((b) => b.length === 1));
}

console.log('\n[3] regroupBatch — a batch reads as contiguous documents');
{
  const flat = flattenDocs(docs);
  const grouped = regroupBatch(flat);
  check('files come back in first-seen order', grouped.map((g) => g.fileName).join('|') === 'AFF.docx|1NC.docx');
  check('each file keeps its own card order', grouped[0].cards.map((c) => c.tag).join('|') === 'heg 1|heg 2|econ 1');

  // A batch that straddles a file boundary must still group cleanly.
  const straddle = regroupBatch(flat.slice(2, 4));
  check('a straddling batch yields both files', straddle.length === 2);
  check('straddling batch keeps only its own cards',
    straddle[0].cards.length === 1 && straddle[1].cards.length === 1);
  check('straddling batch preserves order', straddle.map((g) => g.cards[0].tag).join('|') === 'econ 1|politics uq');

  // Interleaved files (rare, but the flat list makes it representable).
  const interleaved: FlatFlowCard[] = [
    { fileName: 'A', card: card('a1') }, { fileName: 'B', card: card('b1') }, { fileName: 'A', card: card('a2') },
  ];
  const re = regroupBatch(interleaved);
  check('interleaved files are merged, not duplicated', re.length === 2);
  check('merged file keeps both of its cards in order',
    re[0].cards.map((c) => c.tag).join('|') === 'a1|a2');
}

console.log('\n[4] mergeSheetNames — later batches inherit tabs earlier ones invented');
{
  const known = ['Case', 'Off 1'];
  const merged = mergeSheetNames(known, [{ sheetName: 'Heg Adv' }, { sheetName: 'Case' }, { sheetName: 'Politics DA' }]);
  check('new names are appended', merged.join('|') === 'Case|Off 1|Heg Adv|Politics DA', merged.join('|'));
  check('an existing name is not duplicated', merged.filter((s) => s === 'Case').length === 1);

  const caseInsensitive = mergeSheetNames(['Case'], [{ sheetName: 'case' }, { sheetName: 'CASE' }]);
  check('duplicate detection is case-insensitive', caseInsensitive.length === 1, caseInsensitive.join('|'));

  const spaced = mergeSheetNames(['Case'], [{ sheetName: '  Case  ' }]);
  check('duplicate detection ignores surrounding whitespace', spaced.length === 1);

  check('blank names are ignored', mergeSheetNames(['Case'], [{ sheetName: '   ' }, { sheetName: '' }]).length === 1);
  check('a missing sheetName is ignored', mergeSheetNames(['Case'], [{}]).length === 1);
  check('original list is not mutated', known.length === 2);

  // The whole point: two batches naming the same position differently must not
  // silently become two tabs — batch 2 sees batch 1's name and can match it.
  const afterBatch1 = mergeSheetNames(['Case'], [{ sheetName: 'Heg Adv' }]);
  check('batch 2 is told about batch 1\'s new tab', afterBatch1.includes('Heg Adv'));
}

console.log('\n[5] normalizePlacements — answers are indices, text comes from our own data');
{
  // The model returns NUMBERS. Tag and fileName are looked up from the batch, so
  // it can neither mistype a tagline nor break respondsTo matching by
  // paraphrasing one — which is what the old verbatim-echo contract allowed.
  const batch = flattenDocs([
    { fileName: 'AFF.docx', cards: [card('heg 1'), card('econ 1')] },
    { fileName: '1NC.docx', cards: [card('no link', '1NC')] },
  ]);
  const raw = [
    { i: 0, column: '1AC', sheetName: 'Case', cite: 'X 24', isNewSheet: true, sheetRole: 'advantage' },
    { i: 2, column: '1NC', sheetName: 'Case', respondsTo: 0 },
    { i: 1, sheetName: 'Case' },                 // no column   → dropped
    { i: 1, column: '2AC' },                     // no sheet    → dropped
    { i: 99, column: '1AC', sheetName: 'Case' }, // bad index   → dropped
    null,
  ];
  const out = normalizePlacements(raw, batch);
  check('only rows with a real index + column + sheet survive', out.length === 2, `got ${out.length}`);
  check('the dropped count is derivable', raw.length - out.length === 4);
  check('tag is taken from OUR data, never the model', out[0].tag === 'heg 1');
  check('fileName is taken from our data too', out[1].fileName === '1NC.docx');
  check('the model-supplied short cite is used', out[0].cite === 'X 24');
  // The fallback SHORTENS the card's own cite — it does not copy the raw
  // paragraph in, which used to dump every qual and job title into a flow cell.
  check('a missing cite falls back to a SHORTENED form of the card\'s own',
    out[1].cite === "Smith '24", `got "${out[1].cite}"`);
  check('the fallback never contains the quals', !/Professor|March/.test(out[1].cite));
  check('sheetRole passes through when valid', out[0].sheetRole === 'advantage');
  check('respondsTo index resolves to the real tagline',
    out[1].respondsTo === 'heg 1', String(out[1].respondsTo));

  const one = (p: any) => normalizePlacements([{ i: 0, column: 'c', sheetName: 's', ...p }], batch)[0];
  check('an invalid sheetRole becomes null', one({ sheetRole: 'nonsense' }).sheetRole === null);
  check('a null respondsTo stays null', one({ respondsTo: null }).respondsTo === null);
  check('an omitted respondsTo is null', one({}).respondsTo === null);
  check('an out-of-range respondsTo is null, not a crash', one({ respondsTo: 99 }).respondsTo === null);
  check('a card cannot answer itself', one({ respondsTo: 0 }).respondsTo === null);
  check('a string index still resolves', normalizePlacements([{ i: '1', column: 'c', sheetName: 's' }], batch)[0].tag === 'econ 1');
  check('a non-integer index is dropped', normalizePlacements([{ i: 1.5, column: 'c', sheetName: 's' }], batch).length === 0);
  check('non-array input does not throw', normalizePlacements(undefined as any, batch).length === 0);
  check('an empty batch drops everything rather than throwing',
    normalizePlacements([{ i: 0, column: 'c', sheetName: 's' }], []).length === 0);
}

console.log('\n[5b] regroupBatch numbers every card for the model to answer with');
{
  const batch = flattenDocs([
    { fileName: 'AFF.docx', cards: [card('a'), card('b')] },
    { fileName: '1NC.docx', cards: [card('c', '1NC')] },
  ]);
  const grouped = regroupBatch(batch);
  const idx = grouped.flatMap((g) => g.cards.map((c: any) => c.i));
  check('indices are 0..n-1 across the whole batch', idx.join(',') === '0,1,2', idx.join(','));
  check('an index identifies the same card the batch holds',
    (grouped[1].cards[0] as any).i === 2 && batch[2].card.tag === 'c');
}

console.log('\n[6] End-to-end shape — a 778-card packet batches without loss');
{
  // The AFF doc that triggered the original bug measured 778 Heading-4 tags.
  const big: DocGroup[] = [{ fileName: 'AFF.docx', cards: Array.from({ length: 778 }, (_, i) => card(`tag ${i}`)) }];
  const flat = flattenDocs(big);
  const batches = chunkCards(flat, 120);
  check('778 cards flatten intact', flat.length === 778);
  check('they split into 7 batches at size 120', batches.length === 7, `got ${batches.length}`);
  check('every card lands in exactly one batch', batches.flat().length === 778);
  check('the final batch holds the remainder', batches[batches.length - 1].length === 778 - 6 * 120);
  check('no batch is empty', batches.every((b) => b.length > 0));
  check('order is fully preserved end to end',
    batches.flat().map((f) => f.card.tag).join('|') === flat.map((f) => f.card.tag).join('|'));

  // Every batch must serialize to something far under the old 60k cap — that is
  // what makes truncation unnecessary rather than merely less likely.
  const biggest = Math.max(...batches.map((b) => JSON.stringify(regroupBatch(b)).length));
  check('each batch serializes well under the old 60k truncation point', biggest < 60000, `biggest ${biggest}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
