// ── Flow cell HTML sanitizer ─────────────────────────────────────────────────
// Cell content is rich text, but it is NOT all locally trusted: it arrives from
// remote collaborators over the live broadcast channel (Y.Doc updates), from
// AI / MCP-written values, and from the system clipboard, any of which could
// smuggle in <img onerror=…>, <script>, event handlers, or javascript: URLs.
// Before any cell HTML reaches a live innerHTML we parse it inertly (DOMParser
// never loads resources or runs script), drop every element/attribute outside a
// small formatting allowlist, and reserialize. execCommand-produced formatting
// (b/i/u/strike/br/spans) is preserved; anything dangerous is stripped.
//
// Lives apart from FlowView.tsx so it can be exercised by scripts/test-cell-paste.ts.

// Highlighter color (amber) for ⌘⇧H. Cells force dark ink on any highlighted
// span (see the .flow-cell rule in index.css) so it stays readable in dark mode.
export const HILITE = '#fde68a';
export const HILITE_RGB = 'rgb(253,230,138)';

export const HTML_RE = /<(br|div|span|b|i|u|s|strike|em|strong|p)[\s/>]/i;

const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'BR', 'DIV', 'P', 'SPAN', 'FONT', 'SUB', 'SUP']);
const VOID_TAGS = new Set(['BR']);
// Subtrees whose raw text must never be emitted (unwrapping would leak their contents).
const DROP_SUBTREE = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH']);

// Note what is NOT here: `color`, `font-family`, and `font-size`. Nothing in the
// app can legitimately set those on a cell — there is no text-color picker, the
// per-column colors live on the cell's wrapper, and cell font size is a
// view-level setting. So a run carrying any of them can only have come from
// pasted Word / Google Docs markup, which is exactly what we want to shed: it is
// why a pasted tag used to land in 22pt black-on-dark. Excluding them here (and
// not just on the paste path) means cells pasted before that fix also come back
// clean the next time they render.
export const ALLOWED_STYLE_PROPS = new Set([
  'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'background-color', 'vertical-align',
]);

// Paste is stricter still: `background-color` is dropped too. Word and Google
// Docs stamp it on nearly every span with junk values (`transparent`, `white`),
// which would paint boxes inside cells and trip the `.flow-cell` dark-ink rule
// that exists for our own ⌘⇧H highlight spans. Emphasis (bold / italic /
// underline / strike / sub / sup) still survives; a highlight can be re-applied
// in-cell with ⌘⇧H.
const PASTE_DROPPED_PROPS = new Set(['background-color']);
export const PASTE_STYLE_PROPS = new Set([...ALLOWED_STYLE_PROPS].filter((p) => !PASTE_DROPPED_PROPS.has(p)));

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeStyle(style: string, props: Set<string>): string {
  return style
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((decl) => {
      const idx = decl.indexOf(':');
      if (idx < 0) return false;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      const val = decl.slice(idx + 1).trim().toLowerCase();
      if (!props.has(prop)) return false;
      // Reject anything that could fetch a resource or execute.
      if (/url\(|expression|javascript:|@import|[<>]/.test(val)) return false;
      return true;
    })
    .join('; ');
}

// Cells render with `white-space: pre-wrap` so typed spacing survives, which
// means a literal newline in the markup becomes a real blank line on screen.
// Word and Google Docs pretty-print their clipboard HTML — newlines and indent
// between every tag — so pasted markup arrives carrying blank lines it never
// intended. Collapse newlines/tabs (which can only come from that source; typing
// produces <br>, never a raw newline in a text node) while leaving runs of
// spaces alone, since pre-wrap preserves those on purpose.
function collapseSourceWhitespace(s: string): string {
  return s.replace(/[\n\r\t]+/g, ' ');
}

function sanitizeNode(node: Node, out: string[], props: Set<string>): void {
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      out.push(escapeHtml(collapseSourceWhitespace(child.textContent || '')));
      return;
    }
    if (child.nodeType !== 1 /* ELEMENT_NODE */) return;
    const el = child as HTMLElement;
    const tag = el.tagName;
    if (DROP_SUBTREE.has(tag)) return; // skip element and everything under it
    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown-but-harmless wrapper: drop the tag, keep its (sanitized) children.
      sanitizeNode(el, out, props);
      return;
    }
    const name = tag.toLowerCase();
    if (VOID_TAGS.has(tag)) { out.push(`<${name}>`); return; }
    const style = sanitizeStyle(el.getAttribute('style') || '', props);
    out.push(style ? `<${name} style="${escapeAttr(style)}">` : `<${name}>`);
    sanitizeNode(el, out, props);
    out.push(`</${name}>`);
  });
}

export function sanitizeCellHtml(html: string, props: Set<string> = ALLOWED_STYLE_PROPS): string {
  if (!html || !/[<&]/.test(html)) return html; // plain text — nothing to strip
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  sanitizeNode(doc.body, out, props);
  return out.join('');
}

export function cellToHtml(value: string): string {
  if (!value) return '';
  if (HTML_RE.test(value)) return sanitizeCellHtml(value);
  return escapeHtml(value).replace(/\n/g, '<br>');
}

export function htmlToText(html: string): string {
  if (!html) return '';
  if (!HTML_RE.test(html) && !/[<&]/.test(html)) return html;
  // Parse inertly rather than assigning to a live element, so a hostile
  // <img onerror> in remote/AI content can't fire while we extract text.
  const doc = new DOMParser().parseFromString(sanitizeCellHtml(html), 'text/html');
  // Preserve line breaks the way innerText did (<br>/<div> → newline).
  doc.body.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.body.querySelectorAll('div, p').forEach((b) => { b.append('\n'); });
  return (doc.body.textContent || '').replace(/\n{2,}/g, '\n').replace(/\n$/, '');
}

// Block-level tags in pasted markup. A cell is a single flowing run of text, not
// a document, so these are flattened to a <br> rather than kept: a surviving <p>
// brings Word's default 1em margin with it, which reads as a blank line above and
// below every pasted paragraph.
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL',
  'TABLE', 'TR', 'TD', 'TH', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'PRE',
]);

// Paste-specific walk: like sanitizeNode, but flattens block structure to <br>
// and collapses insignificant whitespace the way normal (non-pre-wrap) HTML
// rendering would — pasted markup is authored for that model, not for a cell.
function pasteNode(node: Node, out: string[]): void {
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      out.push(escapeHtml((child.textContent || '').replace(/\s+/g, ' ')));
      return;
    }
    if (child.nodeType !== 1 /* ELEMENT_NODE */) return;
    const el = child as HTMLElement;
    const tag = el.tagName;
    if (DROP_SUBTREE.has(tag)) return;
    if (tag === 'BR') { out.push('<br>'); return; }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) out.push('<br>');
    if (!isBlock && ALLOWED_TAGS.has(tag)) {
      const name = tag.toLowerCase();
      const style = sanitizeStyle(el.getAttribute('style') || '', PASTE_STYLE_PROPS);
      out.push(style ? `<${name} style="${escapeAttr(style)}">` : `<${name}>`);
      pasteNode(el, out);
      out.push(`</${name}>`);
    } else {
      pasteNode(el, out); // unwrap: a block we're flattening, or an unknown tag
    }
    if (isBlock) out.push('<br>');
  });
}

// Turn clipboard data into HTML safe to insert into a cell. Returns '' when
// there is nothing to paste.
export function cleanPastedHtml(html: string, text: string): string {
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out: string[] = [];
    pasteNode(doc.body, out);
    const cleaned = out.join('')
      // Every block emitted a <br> on each side, and empty Word paragraphs emit
      // nothing else — collapse each run down to a single line break.
      .replace(/(?:\s*<br>\s*)+/g, '<br>')
      // Drop the breaks/space now stranded at the very start and end.
      .replace(/^(?:<br>|\s)+/, '')
      .replace(/(?:<br>|\s)+$/, '');
    if (cleaned.trim()) return cleaned;
  }
  // Fall back to plain text when the clipboard HTML sanitizes down to nothing
  // (e.g. it was all wrapper chrome), so the paste never silently no-ops.
  return text ? escapeHtml(text).replace(/\r?\n/g, '<br>') : '';
}

// ── Whole-cell emphasis (multi-cell selection) ───────────────────────────────
//
// The toolbar's B/I/U/S/H normally act on the caret's selection via
// `execCommand`, which needs the cell focused. With several cells selected
// there is no caret and no focus, so emphasis is applied by rewriting each
// cell's HTML instead. Pure, so scripts/test-cell-emphasis.ts can exercise it.
//
// BOLD IS THE BASELINE. Flow cells render bold by default (see `.flow-cell` in
// index.css) — a tagline is the normal case and typing shouldn't need a
// keystroke to look like one. So "not bold" is the marked state, carried by an
// explicit `font-weight: normal`, and every other emphasis works the usual way
// round. `BASE_ON` is what the cell looks like with no markup at all.

export type Emphasis = 'bold' | 'italic' | 'underline' | 'strikeThrough' | 'highlight';

const BASE_ON: Record<Emphasis, boolean> = {
  bold: true, italic: false, underline: false, strikeThrough: false, highlight: false,
};

// Tags that turn an emphasis ON, and the style property that carries it either way.
const EMPHASIS_TAGS: Record<Emphasis, Set<string>> = {
  bold: new Set(['B', 'STRONG']),
  italic: new Set(['I', 'EM']),
  underline: new Set(['U']),
  strikeThrough: new Set(['S', 'STRIKE', 'DEL']),
  highlight: new Set(),
};
const EMPHASIS_PROPS: Record<Emphasis, string[]> = {
  bold: ['font-weight'],
  italic: ['font-style'],
  underline: ['text-decoration', 'text-decoration-line'],
  strikeThrough: ['text-decoration', 'text-decoration-line'],
  highlight: ['background-color'],
};

// Does this declaration value turn the emphasis on? (null = says nothing.)
function valueSaysOn(e: Emphasis, prop: string, raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (e === 'bold') return v === 'bolder' || v === 'bold' || (/^\d+$/.test(v) ? Number(v) >= 600 : false) ? true : (v === 'normal' || v === 'lighter' || /^\d+$/.test(v) ? false : null);
  if (e === 'italic') return v === 'italic' || v === 'oblique' ? true : (v === 'normal' ? false : null);
  if (e === 'underline') return v.includes('underline') ? true : (v === 'none' ? false : null);
  if (e === 'strikeThrough') return v.includes('line-through') ? true : (v === 'none' ? false : null);
  // highlight: any real color is on; transparent/none is off.
  if (prop !== 'background-color') return null;
  return v === 'transparent' || v === 'none' || v === 'initial' ? false : true;
}

function styleDecls(el: Element): [string, string][] {
  return (el.getAttribute('style') || '').split(';')
    .map((d) => d.trim()).filter(Boolean)
    .map((d) => { const i = d.indexOf(':'); return [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()] as [string, string]; })
    .filter(([p]) => p);
}

// What this one element says about `e`: on, off, or nothing.
function elementSays(el: Element, e: Emphasis): boolean | null {
  let out: boolean | null = null;
  for (const [prop, val] of styleDecls(el)) {
    if (!EMPHASIS_PROPS[e].includes(prop)) continue;
    const says = valueSaysOn(e, prop, val);
    if (says !== null) out = says;
  }
  if (out !== null) return out;              // an explicit style beats the tag
  return EMPHASIS_TAGS[e].has(el.tagName) ? true : null;
}

// Walk up from a text node: the nearest ancestor that says anything wins.
function effectiveAt(node: Node, root: Element, e: Emphasis): boolean {
  let cur: Node | null = node.parentNode;
  while (cur && cur !== root.parentNode) {
    if (cur.nodeType === 1) {
      const says = elementSays(cur as Element, e);
      if (says !== null) return says;
    }
    cur = cur.parentNode;
  }
  return BASE_ON[e];
}

function textNodesOf(root: Element): Text[] {
  const out: Text[] = [];
  const walk = (n: Node) => {
    n.childNodes.forEach((c) => {
      if (c.nodeType === 3) { if ((c.textContent || '').trim()) out.push(c as Text); }
      else if (c.nodeType === 1) walk(c);
    });
  };
  walk(root);
  return out;
}

function parseBody(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<div id="wr-root">${html || ''}</div>`, 'text/html')
    .getElementById('wr-root') as HTMLElement;
}

/**
 * Does every bit of text in this cell carry `e`? A cell with no text at all
 * reports the baseline, so an empty selection still toggles predictably.
 */
export function cellHasEmphasis(html: string, e: Emphasis): boolean {
  const root = parseBody(html);
  const texts = textNodesOf(root);
  if (texts.length === 0) return BASE_ON[e];
  return texts.every((t) => effectiveAt(t, root, e));
}

// Remove every marker for `e` in the subtree — the ON tags, and the style
// declarations either way — so the cell falls back to the baseline before a
// single wrapper re-states it. Without this, toggling twice would leave nested
// contradictory markup ("<b><span style=font-weight:normal>").
function stripEmphasis(root: Element, e: Emphasis): void {
  root.querySelectorAll('*').forEach((el) => {
    const decls = styleDecls(el).filter(([p]) => !EMPHASIS_PROPS[e].includes(p));
    if (decls.length) el.setAttribute('style', decls.map(([p, v]) => `${p}: ${v}`).join('; '));
    else el.removeAttribute('style');
  });
  // Unwrap the emphasis tags themselves (deepest first, so nesting unwinds).
  const tags = [...EMPHASIS_TAGS[e]];
  if (tags.length) {
    const doomed = [...root.querySelectorAll(tags.join(','))].reverse();
    doomed.forEach((el) => { while (el.firstChild) el.parentNode!.insertBefore(el.firstChild, el); el.remove(); });
  }
  // A <span> left with no attributes is pure noise now.
  [...root.querySelectorAll('span')].reverse().forEach((el) => {
    if (el.attributes.length === 0) { while (el.firstChild) el.parentNode!.insertBefore(el.firstChild, el); el.remove(); }
  });
}

const WRAPPER: Record<Emphasis, { on: string; off: string }> = {
  bold:          { on: '<b>',  off: '<span style="font-weight: normal">' },
  italic:        { on: '<i>',  off: '<span style="font-style: normal">' },
  underline:     { on: '<u>',  off: '<span style="text-decoration: none">' },
  strikeThrough: { on: '<s>',  off: '<span style="text-decoration: none">' },
  highlight:     { on: `<span style="background-color: ${HILITE}">`, off: '<span style="background-color: transparent">' },
};

/**
 * Turn `e` on or off across a WHOLE cell. Strips existing markers for that one
 * emphasis, then wraps the cell once if the wanted state differs from the
 * baseline — so bold-on and italic-off both come back as clean, unwrapped
 * markup rather than an accumulating pile of spans. Other emphasis is untouched.
 */
export function setCellEmphasis(html: string, e: Emphasis, on: boolean): string {
  const root = parseBody(html);
  if (textNodesOf(root).length === 0) return html; // nothing to format
  stripEmphasis(root, e);
  const inner = sanitizeCellHtml(root.innerHTML);
  if (on === BASE_ON[e]) return inner;
  const open = on ? WRAPPER[e].on : WRAPPER[e].off;
  const close = `</${open.slice(1).split(/[\s>]/)[0]}>`;
  return sanitizeCellHtml(`${open}${inner}${close}`);
}

// Every range in `el` matching `q` (already lowercased). Emphasis splits a cell's
// text across nodes — "preventable <u>death</u>" is two of them — so searching
// each text node on its own would miss any hit that straddles a tag, which is
// exactly where a tag's underlined portion begins. Flatten to one string, search
// that, then map the offsets back onto the nodes they came from.
export function matchRangesIn(el: HTMLElement, q: string): Range[] {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let flat = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = node as Text;
    if (!t.length) continue;
    starts.push(flat.length);
    nodes.push(t);
    flat += t.data;
  }
  if (!nodes.length) return [];

  // `atEnd` picks the node a boundary belongs to when it lands exactly on a seam:
  // a range's start opens the following node, its end closes the preceding one.
  const locate = (pos: number, atEnd: boolean) => {
    for (let k = nodes.length - 1; k >= 0; k--) {
      const s = starts[k];
      const e = s + nodes[k].length;
      if (atEnd ? pos > s && pos <= e : pos >= s && pos < e) return { node: nodes[k], offset: pos - s };
    }
    const k = atEnd ? nodes.length - 1 : 0;
    return { node: nodes[k], offset: atEnd ? nodes[k].length : 0 };
  };

  const hay = flat.toLowerCase();
  const out: Range[] = [];
  let i = hay.indexOf(q);
  while (i !== -1) {
    const end = i + q.length;
    const a = locate(i, false);
    const b = locate(end, true);
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    out.push(r);
    i = hay.indexOf(q, end);
  }
  return out;
}