// Exercises the flow-cell clipboard cleaning and sanitizer against real-world
// clipboard payloads (Word, Google Docs) plus hostile input. jsdom supplies the
// DOMParser the sanitizer relies on in the renderer.
//
// Run:  npx tsx scripts/test-cell-paste.ts

import { JSDOM } from 'jsdom';

const dom = new JSDOM('');
(globalThis as any).DOMParser = dom.window.DOMParser;

const { cleanPastedHtml, sanitizeCellHtml, cellToHtml, htmlToText, matchRangesIn } = await import('../src/lib/cellHtml');

// matchRangesIn walks a live element, so give it a real document to walk.
(globalThis as any).document = dom.window.document;
(globalThis as any).NodeFilter = dom.window.NodeFilter;
function cellWith(html: string) {
  const el = dom.window.document.createElement('div');
  el.innerHTML = html;
  return el as unknown as HTMLElement;
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}

// A real Word clipboard payload for a bolded, underlined tag copied out of a
// Verbatim speech doc: mso <style> block, class attrs, explicit font + size +
// white ink, and an <o:p> Office tag.
const WORD_TAG = `<html xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta charset="utf-8"><style><!-- p.MsoNormal {font-family:"Calibri",sans-serif;} --></style></head>
<body lang=EN-US>
<p class=MsoNormal><b><u><span style='font-size:12.0pt;font-family:"Calibri",sans-serif;color:white;background:yellow'>Warming causes extinction</span></u></b><o:p></o:p></p>
</body></html>`;

console.log('\n[1] Word tag paste');
{
  const out = cleanPastedHtml(WORD_TAG, 'Warming causes extinction');
  check('keeps the text', out.includes('Warming causes extinction'), out);
  check('keeps bold', /<b>/.test(out), out);
  check('keeps underline', /<u>/.test(out), out);
  check('drops font-family', !/font-family/i.test(out), out);
  check('drops font-size', !/font-size/i.test(out), out);
  check('drops the white ink color', !/color\s*:/i.test(out), out);
  check('drops Word background shorthand', !/background/i.test(out), out);
  check('drops the mso <style> block contents', !/MsoNormal\s*\{/.test(out), out);
  check('drops class attributes', !/class=/i.test(out), out);
}

// Google Docs emits background-color:transparent on every span. Left in, it
// would match the .flow-cell `span[style*="background-color"]` dark-ink rule and
// force pasted text to near-black — invisible in dark mode.
console.log('\n[2] Google Docs paste (background-color:transparent trap)');
{
  const GDOCS = `<meta charset="utf-8"><b style="font-weight:normal"><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-style:italic;">Perm do both</span></b>`;
  const out = cleanPastedHtml(GDOCS, 'Perm do both');
  check('keeps the text', out.includes('Perm do both'), out);
  check('keeps italic', /font-style:\s*italic/.test(out), out);
  check('drops background-color entirely', !/background-color/i.test(out), out);
  check('drops color', !/color\s*:/i.test(out), out);
}

console.log('\n[3] Plain-text clipboard / fallbacks');
{
  check('plain text is escaped', cleanPastedHtml('', 'a < b & c') === 'a &lt; b &amp; c');
  check('newlines become <br>', cleanPastedHtml('', 'one\ntwo') === 'one<br>two');
  check('CRLF becomes one <br>', cleanPastedHtml('', 'one\r\ntwo') === 'one<br>two');
  check('empty clipboard yields nothing', cleanPastedHtml('', '') === '');
  // HTML that sanitizes away to nothing must fall back to the text flavor.
  check('wrapper-only HTML falls back to text', cleanPastedHtml('<meta charset="utf-8">', 'hello') === 'hello', cleanPastedHtml('<meta charset="utf-8">', 'hello'));
}

console.log('\n[4] Hostile clipboard / remote content');
{
  check('script is dropped', !/alert/.test(cleanPastedHtml('<script>alert(1)</script>ok', '')), cleanPastedHtml('<script>alert(1)</script>ok', ''));
  check('img onerror is dropped', !/onerror|<img/i.test(cleanPastedHtml('<img src=x onerror=alert(1)>hi', '')), cleanPastedHtml('<img src=x onerror=alert(1)>hi', ''));
  check('event handlers on allowed tags are dropped', !/onclick/i.test(cleanPastedHtml('<b onclick="alert(1)">x</b>', '')), cleanPastedHtml('<b onclick="alert(1)">x</b>', ''));
  check('javascript: url in style is dropped', !/javascript/i.test(sanitizeCellHtml('<span style="background-color:javascript:alert(1)">x</span>')), sanitizeCellHtml('<span style="background-color:javascript:alert(1)">x</span>'));
  check('url() in style is dropped', !/url\(/i.test(sanitizeCellHtml('<span style="background-color:url(http://x/a.png)">x</span>')));
  check('iframe subtree text never leaks', !/evil/.test(cleanPastedHtml('<iframe>evil</iframe>safe', '')), cleanPastedHtml('<iframe>evil</iframe>safe', ''));
}

// The ⌘⇧H highlight must survive a normal (non-paste) sanitize round-trip,
// otherwise reopening a flow would strip every highlight the user applied.
console.log('\n[5] Our own highlight survives the render path');
{
  const hi = '<span style="background-color: rgb(253, 230, 138);">dropped</span>';
  const out = cellToHtml(hi);
  check('highlight span survives cellToHtml', /background-color/.test(out), out);
  check('highlight text survives', out.includes('dropped'), out);
  check('paste path would strip it (by design)', !/background-color/.test(cleanPastedHtml(hi, 'dropped')));
}

// Cells pasted before the paste-cleaning existed still hold raw Word markup in
// storage. The render path must scrub them too, otherwise a 22pt black-on-dark
// tag stays broken forever — reopening the flow would never repair it.
console.log('\n[6] Legacy Word markup already in a cell is cleaned on render');
{
  const legacy = `<span style="font-size:22.0pt;font-family:Calibri;color:#000000"><b>The impact is preventable death</b></span>`;
  const out = cellToHtml(legacy);
  check('keeps the text', out.includes('The impact is preventable death'), out);
  check('keeps bold', /<b>/.test(out), out);
  check('strips the black ink', !/color\s*:/i.test(out), out);
  check('strips the 22pt size', !/font-size/i.test(out), out);
  check('strips the font family', !/font-family/i.test(out), out);
  // font-weight is emphasis, not chrome — it must not be collateral damage.
  check('font-weight still allowed', /font-weight:\s*bold/.test(cellToHtml('<span style="font-weight:bold">x</span>')), cellToHtml('<span style="font-weight:bold">x</span>'));
}

// Cells render with `white-space: pre-wrap`, so a literal newline in the markup
// is a real blank line on screen — and Word/Docs pretty-print their clipboard
// HTML with newlines between every tag. Left alone, a pasted tag arrives with
// blank lines above it and a gap before its cite (and <p> adds a 1em margin on
// top of that). Paste must flatten to a single flowing run.
console.log('\n[7] Word block structure is flattened, not blank-lined');
{
  const WORD_TAG_AND_CITE = `<html><head><style><!--p.MsoNormal{margin:0}--></style></head>
<body lang=EN-US>

<p class=MsoNormal><b><span style='font-size:12.0pt;color:black'>The impact is preventable <u>death</u>.</span></b></p>

<p class=MsoNormal><b><span style='font-size:12.0pt;color:black'>Wright 17</span></b></p>

</body></html>`;
  const out = cleanPastedHtml(WORD_TAG_AND_CITE, '');
  check('no literal newlines survive', !/[\n\r\t]/.test(out), JSON.stringify(out));
  check('no <p> survives (it carries a 1em margin)', !/<p>/.test(out), out);
  check('paragraphs become exactly one <br>', (out.match(/<br>/g) || []).length === 1, out);
  check('no leading break or space', !/^(<br>|\s)/.test(out), JSON.stringify(out));
  check('no trailing break or space', !/(<br>|\s)$/.test(out), JSON.stringify(out));
  check('underline inside the tag survives', /<u>death<\/u>/.test(out), out);
  check('bold survives', /<b>/.test(out), out);
  check('both paragraphs kept', out.includes('preventable') && out.includes('Wright 17'), out);
}

console.log('\n[8] Empty paragraphs and stray whitespace collapse');
{
  check('empty Word paragraphs do not stack breaks',
    cleanPastedHtml('<p>A</p><p></p><p>&nbsp;</p><p>B</p>', '') === 'A<br>B',
    cleanPastedHtml('<p>A</p><p></p><p>&nbsp;</p><p>B</p>', ''));
  check('nested blocks do not multiply breaks',
    cleanPastedHtml('<div><div><p>A</p></div></div><p>B</p>', '') === 'A<br>B',
    cleanPastedHtml('<div><div><p>A</p></div></div><p>B</p>', ''));
  check('explicit <br><br> collapses to one',
    cleanPastedHtml('A<br><br>B', '') === 'A<br>B',
    cleanPastedHtml('A<br><br>B', ''));
  check('inter-tag indentation does not become spaces-galore',
    cleanPastedHtml('<p>A</p>\n\n    \n<p>B</p>', '') === 'A<br>B',
    cleanPastedHtml('<p>A</p>\n\n    \n<p>B</p>', ''));
  check('run of spaces inside a line collapses to one',
    cleanPastedHtml('<span>A     B</span>', '') === '<span>A B</span>',
    cleanPastedHtml('<span>A     B</span>', ''));
}

// Legacy cells still hold Word's <p> markup and its pretty-printing newlines.
// The render path can't flatten blocks (that would rewrite stored content), but
// it must not turn the source newlines into blank lines; the .flow-cell margin
// reset in index.css handles the <p> margins.
console.log('\n[9] Legacy Word markup renders without blank lines');
{
  const legacy = '\n\n<p><b>Tag text</b></p>\n\n<p>Wright 17</p>\n\n';
  const out = cellToHtml(legacy);
  check('source newlines never reach the DOM', !/[\n\r\t]/.test(out), JSON.stringify(out));
  check('text preserved', out.includes('Tag text') && out.includes('Wright 17'), out);
  // Runs of real spaces are pre-wrap's job and must not be collateral damage.
  check('intentional double space survives render', cellToHtml('<span>A  B</span>') === '<span>A  B</span>', cellToHtml('<span>A  B</span>'));
}

// Find highlighting maps flat-string offsets back onto the cell's text nodes.
// Emphasis splits that text up, so the interesting cases are hits that straddle
// a tag boundary — which is most of them in a real tag.
console.log('\n[10] Find match ranges (⌘F highlighting)');
{
  const cell = cellWith('The impact is preventable <u>death</u>, <u>psychological trauma</u>, and <u>financial strain</u>.');
  const one = matchRangesIn(cell, 'preventable death');
  check('match straddling a <u> boundary is found', one.length === 1, String(one.length));
  check('straddling range covers exactly the query', one[0]?.toString() === 'preventable death', one[0]?.toString());

  const inner = matchRangesIn(cell, 'trauma');
  check('match inside a tag is found', inner.length === 1 && inner[0].toString() === 'trauma', inner[0]?.toString());

  const multi = matchRangesIn(cellWith('death and more death'), 'death');
  check('every occurrence is returned', multi.length === 2, String(multi.length));
  check('occurrences do not overlap', multi.every((r) => r.toString() === 'death'));

  check('no match yields nothing', matchRangesIn(cell, 'zzz').length === 0);
  check('empty cell yields nothing', matchRangesIn(cellWith(''), 'x').length === 0);

  // Boundary cases in the offset mapping: a hit that starts at the very first
  // character, and one that ends at the very last.
  const edge = cellWith('<b>alpha</b> mid <i>omega</i>');
  check('hit at the very start maps correctly', matchRangesIn(edge, 'alpha')[0]?.toString() === 'alpha');
  check('hit at the very end maps correctly', matchRangesIn(edge, 'omega')[0]?.toString() === 'omega');
  check('hit spanning three nodes maps correctly', matchRangesIn(edge, 'alpha mid omega')[0]?.toString() === 'alpha mid omega', matchRangesIn(edge, 'alpha mid omega')[0]?.toString());
  check('whole-content match maps correctly', matchRangesIn(cellWith('<b>x</b>'), 'x')[0]?.toString() === 'x');
}

console.log('\n[11] htmlToText round-trip');
{
  check('tags stripped for text', htmlToText('<b>a</b><br><i>b</i>') === 'a\nb', JSON.stringify(htmlToText('<b>a</b><br><i>b</i>')));
  check('entities decoded', htmlToText('a &amp; b') === 'a & b', htmlToText('a &amp; b'));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
