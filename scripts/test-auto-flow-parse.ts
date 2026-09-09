// Tests for the parser-only Auto Flow engine.
//
// The claim being pinned down: a Verbatim doc already encodes both decisions
// Auto Flow asks a model to make. Pocket (H1) is the speech, so it gives the
// COLUMN; hat (H2) names the position, so it gives the SHEET. Measured across
// real speech docs, 100% of cards carry a pocket and 97.9% a real hat — so the
// parser handles the overwhelming majority with no model, no batching, and no
// context limit.
//
// The fixtures below are the exact shapes those real docs use, including the
// two awkward ones: a 1NC that hats every off-case block "OFF", and a send doc
// whose speech label exists only in its filename.
//
// Run:  npx tsx scripts/test-auto-flow-parse.ts

import {
  parseAutoFlow, detectSpeech, columnForSpeech, roleForSpeech,
  sheetForCard, isGenericHeader, looksLikePlan, advantageName, sheetAliasKey, ParseCard,
} from '../src/lib/autoFlowParse';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}

const POLICY = ['1AC', '1NC', '2AC', '2NC/1NR', '1AR', '2NR', '2AR'];
const c = (o: Partial<ParseCard>): ParseCard =>
  ({ pocket: null, hat: null, block: null, tag: 'a tag', cite: "Smith '24 [Jane; quals]", ...o });

console.log('\n[1] detectSpeech — pocket first, then the FILENAME');
{
  check('a plain pocket', detectSpeech('1AC', 'whatever.docx', 'policy') === '1AC');
  check('a decorated pocket', detectSpeech('2NC — Politics', 'x.docx', 'policy') === '2NC');
  // The real reason the filename fallback exists: SEND_2AC---PR.8.20.docx pockets
  // all 29 of its cards under "OFF".
  check('falls back to the filename when the pocket is generic',
    detectSpeech('OFF', 'SEND_2AC---PR.8.20.docx', 'policy') === '2AC');
  check('the pocket still wins when it names a speech',
    detectSpeech('1NC', 'SEND_2AC---PR.docx', 'policy') === '1NC');
  check('no speech anywhere yields null', detectSpeech('Cards', 'notes.docx', 'policy') === null);
  check('a digit-glued near-miss is not a match', detectSpeech('12AC', 'x.docx', 'policy') === null);
  check('PF pockets are recognised', detectSpeech('Con Rebuttal', 'x.docx', 'pf') === 'Con Rebuttal');
  check('PF abbreviations are recognised', detectSpeech('Pro FF', 'x.docx', 'pf') === 'Pro FF');
  check('policy labels do not leak into PF', detectSpeech('1AC', 'x.docx', 'pf') === null);
}

console.log('\n[2] columnForSpeech — the neg block shares one column');
{
  check('an exact column matches', columnForSpeech('1AC', POLICY) === '1AC');
  check('2NC resolves to the merged column', columnForSpeech('2NC', POLICY) === '2NC/1NR');
  check('1NR resolves to the same merged column', columnForSpeech('1NR', POLICY) === '2NC/1NR');
  check('matching is case-insensitive', columnForSpeech('1ac', POLICY) === '1AC');
  check('a speech with no column yields null', columnForSpeech('3NR', POLICY) === null);
  check('a renamed column still matches its own name',
    columnForSpeech('Block', ['1AC', 'Block']) === 'Block');
}

console.log('\n[3] roleForSpeech — drives advantages-before-off-case tab order');
{
  check('1AC is an aff position', roleForSpeech('1AC') === 'advantage');
  check('2AR is an aff position', roleForSpeech('2AR') === 'advantage');
  check('1NC is off-case', roleForSpeech('1NC') === 'offcase');
  check('2NR is off-case', roleForSpeech('2NR') === 'offcase');
  check('Pro is an aff position', roleForSpeech('Pro Case') === 'advantage');
  check('Con is off-case', roleForSpeech('Con Summary') === 'offcase');
  check('null in, null out', roleForSpeech(null) === null);
}

console.log('\n[4] isGenericHeader — a section label is not a position');
{
  for (const g of ['OFF', 'Off Case', 'off-case', '1NC', '1NC---OFF', 'Case', 'Neg', 'Blocks', 'Answers', '']) {
    check(`"${g}" is generic`, isGenericHeader(g));
  }
  for (const n of ['Politics DA', 'Cap K', 'Heg Adv', 'T---Multi Payer', 'Economy', 'Disease']) {
    check(`"${n}" names a real position`, !isGenericHeader(n));
  }
}

console.log('\n[5] sheetForCard — hat, then block, then flagged generic');
{
  const hat = sheetForCard(c({ hat: 'Cap K', block: 'Impact---2NC' }), '2NC');
  check('a real hat wins', hat.name === 'Cap K' && !hat.generic);

  // The 1NC case: hat "Economy", block "AT: Solvency---1NC" → hat wins, and the
  // block's speech suffix is irrelevant because the hat was usable.
  const withHat = sheetForCard(c({ hat: 'Economy', block: 'AT: Solvency---1NC' }), '1NC');
  check('a real hat beats a real block', withHat.name === 'Economy' && !withHat.generic);

  const blockOnly = sheetForCard(c({ hat: 'OFF', block: 'AT: Solvency---1NC' }), '1NC');
  check('a generic hat falls through to the block', blockOnly.name === 'AT: Solvency' && !blockOnly.generic);
  check('the block\'s speech suffix is stripped', !blockOnly.name.includes('1NC'));

  // The genuinely unresolvable case — both headers generic. 16 of the 1NC's 24
  // cards look exactly like this.
  const bothGeneric = sheetForCard(c({ hat: 'OFF', block: '1NC---OFF' }), '1NC');
  check('both generic is FLAGGED, not guessed at', bothGeneric.generic);
  check('it still lands somewhere rather than vanishing', !!bothGeneric.name);
}

console.log('\n[6] looksLikePlan');
{
  check('a 1AC mandate is the plan',
    looksLikePlan(c({ tag: 'The United States federal government should establish single payer.' }), '1AC'));
  check('a "Plan" block header counts', looksLikePlan(c({ block: 'Plan', tag: 'anything' }), '1AC'));
  check('the same text outside the 1AC is not the plan',
    !looksLikePlan(c({ tag: 'The United States federal government should act.' }), '2AC'));
  check('an ordinary 1AC card is not the plan', !looksLikePlan(c({ tag: 'Heg solves war.' }), '1AC'));
}

console.log('\n[7] parseAutoFlow — end to end on real document shapes');
{
  const res = parseAutoFlow({
    event: 'policy',
    columns: POLICY,
    existingSheets: ['Case', 'RFD/Notes'],
    docs: [
      { fileName: 'AFF---Single Payer.docx', cards: [
        c({ pocket: '1AC', hat: '1AC---Single Payer', tag: 'The United States federal government should establish single payer.' }),
        c({ pocket: '1AC', hat: 'Heg Adv', tag: 'Heg solves great power war.', cite: "Brooks '24 [Stephen; quals]" }),
      ] },
      { fileName: '1NC---Practice.docx', cards: [
        c({ pocket: '1NC', hat: 'Economy', block: 'AT: Solvency---1NC', tag: 'Lobbying eliminates cost control.' }),
        c({ pocket: '1NC', hat: 'OFF', block: '1NC---OFF', tag: 'Dems win the midterms now.' }),
      ] },
      { fileName: 'SEND_2AC---PR.docx', cards: [
        c({ pocket: 'OFF', hat: 'Heg Adv', tag: 'Extend Brooks.' }),
      ] },
      { fileName: 'notes.docx', cards: [c({ pocket: 'Misc', tag: 'stray card' })] },
    ],
  });

  const byTag = (t: string) => res.placements.find((p) => p.tag.startsWith(t))!;
  check('every placeable card is placed', res.placements.length === 5, `got ${res.placements.length}`);
  check('the unplaceable card is skipped, not guessed', res.skipped.length === 1);
  check('the skip says why', /no speech label/.test(res.skipped[0].reason), res.skipped[0].reason);

  check('pocket → column', byTag('Heg solves').column === '1AC');
  check('2NC-family speech → merged column', columnForSpeech('1NR', POLICY) === '2NC/1NR');
  check('filename-derived speech → column', byTag('Extend Brooks').column === '2AC');

  check('hat → sheet', byTag('Heg solves').sheetName === 'Heg Adv');
  check('a generic hat falls back to the block', byTag('Lobbying').sheetName === 'Economy');
  check('one generic card is counted as unresolved', res.unresolved === 1, String(res.unresolved));

  check('the plan is detected', byTag('The United States').isPlan);
  check('an ordinary card is not the plan', !byTag('Heg solves').isPlan);

  check('aff role from an aff speech', byTag('Heg solves').sheetRole === 'advantage');
  check('neg role from a neg speech', byTag('Lobbying').sheetRole === 'offcase');

  check('the cite is shortened, not copied whole', byTag('Heg solves').cite === "Brooks '24");
  check('no cite carries quals', res.placements.every((p) => !/quals/.test(p.cite)));

  // A second card on a tab the run already created is not "new" again.
  check('a sheet created in this run is reused',
    res.placements.filter((p) => p.sheetName === 'Heg Adv').filter((p) => p.isNewSheet).length === 1);
  // Reusing a tab must not re-case it — the lookup key is lowercased, the
  // display name is not.
  check('the 2AC card lands on the tab the 1AC made, with its casing intact',
    byTag('Extend Brooks').sheetName === 'Heg Adv', byTag('Extend Brooks').sheetName);
  check('the later opposing-side card is aligned to the earlier one',
    byTag('Extend Brooks').respondsTo === null || typeof byTag('Extend Brooks').respondsTo === 'string');

  // The speech marker is stripped — "Single Payer" is the aff's name, whereas
  // "1AC---Single Payer" is a heading. The flow is named after the former.
  check('the aff name is read off the 1AC hat, without the speech marker',
    res.flowName === 'Single Payer', String(res.flowName));
}

console.log('\n[8] Degenerate input never throws');
{
  const empty = parseAutoFlow({ event: 'policy', columns: POLICY, existingSheets: [], docs: [] });
  check('no docs yields no placements', empty.placements.length === 0);
  check('no docs yields no flow name', empty.flowName === undefined);
  const noCards = parseAutoFlow({ event: 'policy', columns: POLICY, existingSheets: [], docs: [{ fileName: 'x', cards: [] }] });
  check('a doc with no cards is fine', noCards.placements.length === 0);
  const noCols = parseAutoFlow({ event: 'policy', columns: [], existingSheets: [], docs: [{ fileName: '1AC.docx', cards: [c({ pocket: '1AC' })] }] });
  check('a flow with no columns skips rather than crashing', noCols.skipped.length === 1);
}

console.log('\n[9] Advantage names beat the hat, measured on a real 1AC');
{
  // Every card in the real "Single Payer 1AC.docx" is hatted with the AFF and
  // blocked with the advantage. Reading the hat as the position put all 21 cards
  // on one tab called "Single Payer" and lost both advantages entirely.
  check('the advantage name comes out of the block',
    advantageName('1AC---Advantage 1---Economy') === 'Economy',
    String(advantageName('1AC---Advantage 1---Economy')));
  check('"Adv 2" spelling works too', advantageName('Adv 2---Disease') === 'Disease');
  check('a contention works too', advantageName('Contention 1: Warming') === 'Warming');
  check('an ordinary heading is not an advantage', advantageName('States CP') === null);
  check('a bare "Advantage 1" names nothing', advantageName('1AC---Advantage 1') === null);

  const affCard = c({ pocket: '1AC', hat: '1AC---Single Payer', block: '1AC---Advantage 1---Economy' });
  check('the block advantage outranks a perfectly good hat',
    sheetForCard(affCard, '1AC').name === 'Economy', sheetForCard(affCard, '1AC').name);
  // The neg side must NOT change: its hat is the position and its block is the
  // sub-structure, so the hat has to keep winning there.
  const negCard = c({ pocket: '2NC', hat: 'Cap K', block: 'Perm---AT: Do Both---2NC' });
  check('a neg hat still outranks its block', sheetForCard(negCard, '2NC').name === 'Cap K');

  const res = parseAutoFlow({
    event: 'policy', columns: POLICY, existingSheets: [],
    docs: [{ fileName: 'Single Payer 1AC.docx', cards: [
      c({ pocket: '1AC', hat: '1AC---Single Payer', block: '1AC---Advantage 1---Economy', tag: 'econ 1' }),
      c({ pocket: '1AC', hat: '1AC---Single Payer', block: '1AC---Advantage 2---Disease', tag: 'dis 1' }),
    ] }],
  });
  check('the two advantages become two tabs',
    res.placements.map((p) => p.sheetName).join('|') === 'Economy|Disease',
    res.placements.map((p) => p.sheetName).join('|'));
  check('the aff is still the FLOW name, not a tab', res.flowName === 'Single Payer', String(res.flowName));
}

console.log('\n[10] A speech is never a tab name');
{
  // 2NC---Extra.docx has one card and no headings at all. The speech came from
  // the filename, and used to be used as the tab name — producing a tab called
  // "2NC", which is a column in this app, never a position.
  const res = parseAutoFlow({
    event: 'policy', columns: POLICY, existingSheets: [],
    docs: [{ fileName: '2NC---Extra.docx', cards: [c({})] }],
  });
  check('a headingless doc lands on "Unsorted", not "2NC"',
    res.placements[0]?.sheetName === 'Unsorted', String(res.placements[0]?.sheetName));
  check('and it is reported as unresolved', res.unresolved === 1);
  check('a bare speech hat is not a tab name either',
    sheetForCard(c({ pocket: '1NC', hat: '1NC' }), '1NC').name === 'Unsorted');
}

console.log('\n[11] The same position under two names is one tab');
{
  check('a DA suffix is dropped', sheetAliasKey('Midterms DA') === sheetAliasKey('Midterms'));
  check('a CP suffix is dropped', sheetAliasKey('States CP') === sheetAliasKey('States'));
  // The one that must NOT merge: in the measured round these are the aff's
  // advantage and the neg's disad, two different tabs.
  check('"Econ DA" and "Economy" stay apart', sheetAliasKey('Econ DA') !== sheetAliasKey('Economy'));
  check('a leading position letter is kept', sheetAliasKey('T---NHI') === 't nhi', sheetAliasKey('T---NHI'));

  const res = parseAutoFlow({
    event: 'policy', columns: POLICY, existingSheets: [],
    docs: [
      { fileName: 'SEND_2AC.docx', cards: [c({ pocket: '2AC', hat: 'Midterms DA', tag: 'a' })] },
      { fileName: 'SEND_2NC.docx', cards: [c({ pocket: '2NC', hat: 'Midterms', tag: 'b' })] },
    ],
  });
  check('the 2NC kick block joins the 2AC tab',
    res.placements[1]?.sheetName === 'Midterms DA', String(res.placements[1]?.sheetName));
  check('and does not create a second tab', res.placements[1]?.isNewSheet === false);
}

console.log('\n[12] Unresolved cards name the doc that caused it');
{
  const res = parseAutoFlow({
    event: 'policy', columns: POLICY, existingSheets: [],
    docs: [{ fileName: '1NC---Practice.docx', cards: [
      c({ pocket: '1NC', hat: 'OFF', block: '1NC---OFF', tag: 'a' }),
      c({ pocket: '1NC', hat: 'OFF', block: '1NC---OFF', tag: 'b' }),
      c({ pocket: '1NC', hat: 'Economy', block: 'AT: Solvency---1NC', tag: 'c' }),
    ] }],
  });
  check('only the generic ones count', res.unresolved === 2);
  check('the doc is named', res.unresolvedDocs[0]?.fileName === '1NC---Practice.docx');
  check('the offending header is named', res.unresolvedDocs[0]?.sheetName === 'OFF');
  check('with its count', res.unresolvedDocs[0]?.count === 2);
  check('one bucket, not one entry per card', res.unresolvedDocs.length === 1);
}

console.log('\n[13] The pocket is a tab source when it is the only heading');
{
  // Measured across 90 real docs: three put everything under a single ancestor
  // heading, and what they put there is the position, not the speech. 35 aff
  // cards were landing on "Unsorted" with the name sitting right above them.
  check('a pocket that names a position is used',
    sheetForCard(c({ pocket: 'Miscalc. Adv.' }), '1AC').name === 'Miscalc. Adv.');
  check('and it is not counted as unresolved',
    sheetForCard(c({ pocket: 'Miscalc. Adv.' }), '1AC').generic === false);
  check('a speech-marked pocket is stripped first',
    sheetForCard(c({ pocket: '1AC---Inhuman Matter' }), '1AC').name === 'Inhuman Matter');
  // The guards that keep this from firing on the common case.
  check('a bare speech pocket does NOT become a tab',
    sheetForCard(c({ pocket: '1AC' }), '1AC').name === 'Unsorted');
  check('a generic pocket does NOT become a tab',
    sheetForCard(c({ pocket: 'OFF' }), '2AC').name === 'Unsorted');
  check('a hat still outranks the pocket',
    sheetForCard(c({ pocket: 'Case', hat: 'Cap K' }), '2AC').name === 'Cap K');
  check('a block still outranks the pocket',
    sheetForCard(c({ pocket: 'AT:OFF', block: '2AC---Texit DA' }), '2AC').name === 'Texit DA');
}

console.log('\n[14] Speech detection: earliest wins, "AT:" targets are ignored');
{
  // The bug: POLICY_SPEECHES lists '1AC' before '1NC', and the old code returned
  // the first ARRAY match — so a whole 1NC doc was read as 1AC and landed in the
  // aff's first column.
  check('a doc that answers the 1AC is still a 1NC doc',
    detectSpeech(null, '1NC---AT-1AC-Adv.docx', 'policy') === '1NC',
    String(detectSpeech(null, '1NC---AT-1AC-Adv.docx', 'policy')));
  check('the earliest speech in a heading wins',
    detectSpeech('2AC vs 1NC Politics', 'x.docx', 'policy') === '2AC');
  check('order in the string, not order in the array',
    detectSpeech('1NC vs 2AC Politics', 'x.docx', 'policy') === '1NC');
  // "AT:" attaches to whatever it immediately precedes. Here that's "Solvency",
  // so the trailing 1NC is still this card's own speech.
  check('a far-away "AT:" does not disqualify a speech',
    detectSpeech('AT: Solvency---1NC', 'x.docx', 'policy') === '1NC');
  check('"A2:" works the same as "AT:"',
    detectSpeech(null, '2NR---A2-2AR.docx', 'policy') === '2NR');
  // Every speech named is an answers-to target, so the pocket says nothing about
  // this card's own speech — fall through to the filename rather than guess.
  check('a pocket that only names its target falls through to the filename',
    detectSpeech('AT: 2NC Cap', 'SEND_1AR.docx', 'policy') === '1AR',
    String(detectSpeech('AT: 2NC Cap', 'SEND_1AR.docx', 'policy')));
  // Regressions on the shapes that already worked.
  check('the plain send-doc filename case still works',
    detectSpeech('OFF', 'SEND_2AC---PR.8.20.docx', 'policy') === '2AC');
  check('a plain pocket still works', detectSpeech('1AC', 'whatever.docx', 'policy') === '1AC');
  check('"12AC" is still not a speech', detectSpeech('12AC', 'x.docx', 'policy') === null);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
