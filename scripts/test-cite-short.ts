// Tests for short-cite parsing and XML entity decoding.
//
// Two bugs these pin down, both found by running the parser over real speech docs:
//
// 1. `extractFlowCardsFromXml` stripped tags but never decoded entities, so
//    `&amp;` and `&lt;&lt;` reached the caller raw. That got worse when
//    placements became index-keyed: tag and cite text now comes ONLY from this
//    parser (the model no longer retypes it), so an undecoded `&` lands in a
//    flow cell, gets escaped again by buildCellHtml, and renders as "&amp;".
//    Measured on real docs: 116 of 833 cites and 3 taglines.
//
// 2. When the model omitted its short cite, the fallback was the FULL cite
//    paragraph — every qual, job title, and date the prompt explicitly says to
//    strip, written into a flow cell.
//
// Run:  npx tsx scripts/test-cite-short.ts

import { shortCite } from '../src/lib/citeShort';
import { decodeXmlEntities } from '../src/lib/docxFlowCards';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}
function eq(input: string, want: string) {
  const got = shortCite(input);
  check(`"${input.slice(0, 52)}${input.length > 52 ? '…' : ''}" → "${want}"`, got === want, `got "${got}"`);
}

console.log('\n[1] decodeXmlEntities');
{
  check('&amp; becomes &', decodeXmlEntities('Cutler &amp; Klarnet') === 'Cutler & Klarnet');
  check('&lt;/&gt; become angle brackets', decodeXmlEntities('&lt;&lt;FOR REFERENCE&gt;&gt;') === '<<FOR REFERENCE>>');
  check('&quot; becomes a double quote', decodeXmlEntities('say &quot;hi&quot;') === 'say "hi"');
  check('&apos; becomes an apostrophe', decodeXmlEntities('it&apos;s') === "it's");
  check('decimal refs decode', decodeXmlEntities('&#8217;26') === '’26');
  check('hex refs decode', decodeXmlEntities('&#x2019;26') === '’26');
  check('text with no entities is untouched', decodeXmlEntities('plain text') === 'plain text');
  check('empty input does not throw', decodeXmlEntities('') === '');
  // &amp; is decoded LAST so an escaped entity stays escaped rather than
  // becoming a live one.
  check('&amp;lt; yields the literal "&lt;", not "<"', decodeXmlEntities('&amp;lt;') === '&lt;');
  check('an out-of-range code point is dropped, not thrown on', decodeXmlEntities('&#99999999;') === '');
}

console.log('\n[2] shortCite — the bracket shape (author then quals in [])');
{
  eq("Toth ’16 [Federico; May; University of Bologna, Dipartimento di Scienze]", "Toth '16");
  eq("Bruneau ’26 [Jordan; February 4; B.A. in International Relations]", "Bruneau '26");
  eq("ICG ’26 [International Crises Group; July 6; conflict-prevention org]", "ICG '26");
  eq("Kampf 20 (David, PhD Fellow at the Center for Strategic Studies)", "Kampf '20");
}

console.log('\n[3] shortCite — the comma shape (full name then quals)');
{
  eq('Desmond Lachman 22, Senior Fellow at the American Enterprise Institute', "Lachman '22");
  eq('Ralph Nader 25, Former presidential candidate and activist', "Nader '25");
  eq('Dr. Nikhil Venkatesh 25, PhD, Fellow, Dickson Poon School of Law', "Venkatesh '25");
  check('honorifics never survive', !shortCite('Prof. Jane Roe 24, Chair of Something').includes('Prof'));
}

console.log('\n[4] shortCite — multiple authors and et al.');
{
  eq("Cutler &amp; Klarnet ’26 [David; Lev; March; Otto Eckstein Professor]".replace('&amp;', '&'), "Cutler & Klarnet '26");
  eq("Brown & McCuskey '20 [Fuse; Elizabeth; January; Associate Professor]", "Brown & McCuskey '20");
  eq('Frederik Soderbaum et al 21, Associate Research Fellow at UNU-CRIS', "Soderbaum et al. '21");
  eq('Oritsemolebi A. Johnson et al. 25, MBA, Cornell University', "Johnson et al. '25");
  eq("Krieger and Meierrieks 15, Professor of Constitutional Political Economy", "Krieger & Meierrieks '15");
}

console.log('\n[5] shortCite — year forms Verbatim actually uses');
{
  eq("Stanton '7/1 [Andrew; July 1; Newsweek reporter based in Maine]", "Stanton '7/1");
  eq("Mutikani ’4-30 [Lucia; 2026; Economics Correspondent for Reuters]", "Mutikani '4-30");
  eq("Helhoski ’6-25 [Anna and Rick VanderKnyff; 2026; Senior Writer]", "Helhoski '6-25");
  eq("Hampton ‘2k [Andre; 2000; Professor of Law at St. Mary's]", "Hampton '2k".replace("'2k", "'2k"));
}

console.log('\n[6] shortCite — particles stay attached to the surname');
{
  eq('Jan van der Berg 21, Professor of Something', "van der Berg '21");
  eq('Maria de Souza 19, Researcher', "de Souza '19");
}

console.log('\n[7] shortCite — nothing usable yields nothing, never a placeholder');
{
  check('a FOR REFERENCE marker yields nothing', shortCite('<<ICG ’26 FOR REFERENCE>>') === '');
  check('a bare marker yields nothing', shortCite('<<FOR REFERENCE>>') === '');
  check('a misspelled marker still yields nothing', shortCite('<<FOR REFERENECE>>') === '');
  check('empty input yields nothing', shortCite('') === '');
  check('whitespace yields nothing', shortCite('   ') === '');
  check('undefined does not throw', shortCite(undefined as any) === '');
  check('a leading comma yields nothing', shortCite(', just quals here') === '');
}

console.log('\n[8] shortCite never returns the wall of text it was given');
{
  const full = "Galvani ’20 [Alison P. Galvani, Alyssa S. Parpia, Eric M. Foster, Burton H. Singer, "
    + "Meagan C. Fitzpatrick; February 15; Burnett and Stender Families Professor of Epidemiology "
    + "at the Yale School of Public Health; The Lancet, 'Improving the prognosis of health care in the USA']";
  const out = shortCite(full);
  check('output is short enough for a flow cell', out.length <= 30, `${out.length} chars: "${out}"`);
  check('output drops the quals entirely', !/Professor|School|Lancet|February/.test(out), out);
  check('output keeps the surname and year', out === "Galvani '20", out);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
