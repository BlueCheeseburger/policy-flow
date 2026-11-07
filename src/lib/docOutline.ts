// A speech doc's flowable outline, in document order: every pocket, hat and
// block heading, every tagline (with its short cite when it has one), and
// every analytic. This is what Auto Flow's parse mode turns into rows.
//
// Unlike docxFlowCards.ts (which feeds AI sorting), heading levels here are
// Verbatim's own: Heading 1 is a pocket, 2 a hat, 3 a block. Only the TAG
// level moves — it's the deepest heading the doc uses, since plenty of files
// stop at Heading 3. A doc that uses H1 and H3 still has blocks, not hats; a
// block is single underlined and a hat double, so collapsing the gap would
// draw the wrong one.
//
// Never reads card bodies. Undertags (notes to the team) are skipped, and so
// are the paragraphs of card text under a tag after its cite.

import { decodeXmlEntities } from './docxFlowCards';
import { shortCite } from './citeShort';

export type OutlineKind = 'pocket' | 'hat' | 'block' | 'tag' | 'analytic';

export interface OutlineItem {
  kind: OutlineKind;
  text: string;
  /** Short cite, on tags that have one. */
  cite?: string;
}

/**
 * Paragraph styles that are analytics or undertags, by name ("Analytic",
 * "Undertag"), following `basedOn` so a doc's own variant of either counts.
 */
export function resolveNoteStyles(stylesXml: string): { analytic: Set<string>; undertag: Set<string> } {
  const named = new Map<string, { name: string; basedOn: string }>();
  for (const m of String(stylesXml ?? '').matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = (m[1].match(/w:styleId="([^"]+)"/) ?? [])[1];
    if (!id) continue;
    const name = (m[2].match(/<w:name\s+w:val="([^"]+)"/) ?? [])[1] ?? '';
    const basedOn = (m[2].match(/<w:basedOn\s+w:val="([^"]+)"/) ?? [])[1] ?? '';
    named.set(id, { name, basedOn });
  }
  const matches = (id: string, re: RegExp, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const st = named.get(id);
    if (!st) return re.test(id);
    return re.test(st.name) || re.test(id) || (!!st.basedOn && matches(st.basedOn, re, seen));
  };
  const analytic = new Set<string>();
  const undertag = new Set<string>();
  for (const id of named.keys()) {
    if (matches(id, /^undertag/i)) undertag.add(id);
    else if (matches(id, /^analytics?$/i)) analytic.add(id);
  }
  // Docs with no styles.xml entry for them still use the stock ids.
  if (!named.size) { analytic.add('Analytic'); undertag.add('Undertag'); }
  return { analytic, undertag };
}

export function extractOutline(
  xml: string,
  headingLevels: Map<string, number>,
  notes: { analytic: Set<string>; undertag: Set<string> },
): OutlineItem[] {
  const strip = (s: string) => decodeXmlEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  const styleOf = (p: string) => (p.match(/w:pStyle\s+w:val="([^"]+)"/) ?? [])[1] ?? 'Normal';
  const paras = [...String(xml ?? '').matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => m[0]);

  // Analytic and Undertag are often built on Heading 4, so they inherit an
  // outline level; they're checked by name before any heading test.
  const isNote = (style: string) => notes.analytic.has(style) || notes.undertag.has(style);
  let tagLevel = 0;
  for (const p of paras) {
    const st = styleOf(p);
    if (!isNote(st)) tagLevel = Math.max(tagLevel, headingLevels.get(st) ?? 0);
  }

  const out: OutlineItem[] = [];
  // The tag still waiting for its cite: the first plain paragraph after it.
  let pending: OutlineItem | null = null;
  for (const p of paras) {
    const style = styleOf(p);
    const level = isNote(style) ? 0 : headingLevels.get(style) ?? 0;
    if (level > 0) {
      pending = null;
      const text = strip(p);
      if (!text) continue;
      if (level >= tagLevel) {
        pending = { kind: 'tag', text };
        out.push(pending);
      } else {
        out.push({ kind: level === 1 ? 'pocket' : level === 2 ? 'hat' : 'block', text });
      }
      continue;
    }
    if (notes.undertag.has(style)) continue;
    const text = strip(p);
    if (!text) continue;
    if (notes.analytic.has(style)) {
      pending = null;
      // A team note filed as an analytic isn't an argument; nothing to flow.
      if (/^(removed|dated|note|notes|todo)\b/i.test(text)) continue;
      out.push({ kind: 'analytic', text });
      continue;
    }
    if (pending) {
      // A real cite has a year ("Rather 26", "'7-5", "2019"); a paragraph
      // without one is commentary sitting in the cite slot.
      const cite = /\b(19|20)\d{2}\b|\b\d{2}\b|'\d/.test(text) ? shortCite(text) : '';
      if (cite) pending.cite = cite;
      pending = null; // the rest is card text, never read
    }
  }
  return out;
}
