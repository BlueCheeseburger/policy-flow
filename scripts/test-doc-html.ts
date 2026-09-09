// Exercises src/lib/docHtml.ts — the allowlist sanitizer guarding CasePreview's
// dangerouslySetInnerHTML. Every "must strip" case below is a payload that got
// through the regex blacklist this replaced.
//
//   npx tsx scripts/test-doc-html.ts

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
(globalThis as any).DOMParser = dom.window.DOMParser;
(globalThis as any).Element = dom.window.Element;

const { sanitizeDocHtml, sanitizeCss } = await import('../src/lib/docHtml.ts');

let failures = 0;

/** `input` must not survive with anything matching `danger` in it. */
function strips(label: string, input: string, danger: RegExp) {
  const out = sanitizeDocHtml(input);
  const bad = danger.test(out);
  if (bad) failures++;
  console.log(`${bad ? 'FAIL' : 'ok  '}  strip: ${label.padEnd(34)} -> ${out.slice(0, 78)}`);
}

/** `input` must still contain `expected` after sanitizing. */
function keeps(label: string, input: string, expected: RegExp) {
  const out = sanitizeDocHtml(input);
  const ok = expected.test(out);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  keep : ${label.padEnd(34)} -> ${out.slice(0, 78)}`);
}

console.log('— must strip —');
// The three confirmed bypasses of the old regex.
strips('slash-separated handler', '<img/onerror=alert(1) src="data:image/png;base64,AA==">', /onerror/i);
strips('svg with onload', '<svg/onload=alert(1)></svg>', /onload|svg/i);
strips('iframe javascript: src', '<iframe src="javascript:alert(1)"></iframe>', /iframe|javascript:/i);
// Ordinary cases the old regex did catch — must stay caught.
strips('plain inline handler', '<p onclick="alert(1)">hi</p>', /onclick/i);
strips('script element', '<script>alert(1)</script><p>x</p>', /script|alert/i);
strips('newline before handler', '<img src="data:image/png;base64,AA=="\nonerror=alert(1)>', /onerror/i);
strips('uppercase handler', '<P ONMOUSEOVER="alert(1)">x</P>', /onmouseover/i);
// Sinks the old regex never looked at.
strips('object embed', '<object data="x.swf"></object>', /object/i);
strips('form + input', '<form action="//evil"><input name="p"></form>', /<form|<input/i);
strips('base tag', '<base href="//evil/">', /<base/i);
strips('link stylesheet', '<link rel="stylesheet" href="//evil/x.css">', /<link/i);
strips('remote img src', '<img src="https://evil/track.gif">', /evil/i);
strips('style @import', '<style>@import url("//evil/x.css");</style>', /@import|evil/i);
strips('style remote url()', '<style>.a{background:url(//evil/t.png)}</style>', /evil/i);
strips('style expression()', '<style>.a{width:expression(alert(1))}</style>', /expression\s*\(/i);
strips('inline style url()', '<p style="background:url(//evil/t.png)">x</p>', /evil/i);
strips('anchor href', '<a href="javascript:alert(1)">x</a>', /href|javascript:/i);
strips('nested handler in table', '<table><tr><td onmouseover="alert(1)">c</td></tr></table>', /onmouseover/i);
strips('id attribute dropped', '<p id="x">t</p>', /\bid=/i);

console.log('\n— must keep —');
keeps('section + class', '<section class="wr1"><p>Hello</p></section>', /<section class="wr1">.*Hello/is);
keeps('text content of unknown tag', '<unknown>kept text</unknown>', /kept text/);
keeps('bold / italic / underline', '<p><b>b</b><i>i</i><u>u</u></p>', /<b>b<\/b><i>i<\/i><u>u<\/u>/);
keeps('table structure', '<table><tbody><tr><td colspan="2">c</td></tr></tbody></table>', /<td colspan="2">c<\/td>/);
keeps('safe inline style', '<p style="font-weight: bold">x</p>', /font-weight/);
keeps('stylesheet rules', '<style>.wr1 p{margin:0;font-size:12pt}</style>', /font-size:12pt/);
keeps('inline image data uri', '<img src="data:image/png;base64,iVBORw0KGgo=">', /data:image\/png;base64/);
keeps('sub/sup and headings', '<h2>T</h2><p>x<sub>1</sub><sup>2</sup></p>', /<h2>T<\/h2>.*<sub>1<\/sub><sup>2<\/sup>/s);

console.log('\n— sanitizeCss direct —');
const css = sanitizeCss('@import "evil.css"; .a{behavior:url(#x);background:url(data:image/png;base64,AA==)}');
const cssOk = !/@import|behavior/i.test(css) && /data:image\/png/.test(css);
if (!cssOk) failures++;
console.log(`${cssOk ? 'ok  ' : 'FAIL'}  css: drops @import/behavior, keeps data: image`);

console.log(failures === 0 ? '\nAll doc-html sanitizer tests passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
