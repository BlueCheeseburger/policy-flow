// Resolve which paragraph styles are HEADINGS from a docx's word/styles.xml, so
// heading detection works even when a doc's heading styles aren't literally
// named Heading1–9 (Google Docs exports, custom Verbatim templates). Computes
// each PARAGRAPH style's effective Word outline level via, in priority order:
//   1. its own <w:outlineLvl>
//   2. its <w:name> matching "heading N"
//   3. inheritance up its <w:basedOn> chain
// Returns Map<rawStyleId, 1-based heading level> (outlineLvl 0 ⇒ level 1).
//
// Ported unchanged from Warroom's main process — it is pure string work with no
// Node dependency, so it runs the same in a browser tab.

export function resolveHeadingStyles(stylesXml: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!stylesXml) return out;

  interface RawStyle { id: string; name: string; basedOn: string; outlineLvl: number | null; isParagraph: boolean }
  const styles = new Map<string, RawStyle>();
  for (const m of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const attrs = m[1];
    const body = m[2];
    const id = (attrs.match(/w:styleId="([^"]+)"/) ?? [])[1];
    if (!id) continue;
    const type = (attrs.match(/w:type="([^"]+)"/) ?? [])[1] ?? 'paragraph';
    const name = (body.match(/<w:name\s+w:val="([^"]+)"/) ?? [])[1] ?? '';
    const basedOn = (body.match(/<w:basedOn\s+w:val="([^"]+)"/) ?? [])[1] ?? '';
    const lvlStr = (body.match(/<w:outlineLvl\s+w:val="([0-9]+)"/) ?? [])[1];
    styles.set(id, {
      id, name, basedOn,
      outlineLvl: lvlStr !== undefined ? parseInt(lvlStr, 10) : null,
      isParagraph: type === 'paragraph',
    });
  }

  // Resolve a style's effective outline level (0-based), memoized, cycle-safe.
  const cache = new Map<string, number | null>();
  const levelOf = (id: string, seen = new Set<string>()): number | null => {
    if (cache.has(id)) return cache.get(id)!;
    if (seen.has(id)) return null;
    seen.add(id);
    const st = styles.get(id);
    if (!st) return null;
    let lvl: number | null = st.outlineLvl;
    if (lvl === null) {
      const nameMatch = st.name.match(/^heading\s*([1-9])/i);
      if (nameMatch) lvl = parseInt(nameMatch[1], 10) - 1;
    }
    if (lvl === null && st.basedOn) lvl = levelOf(st.basedOn, seen);
    cache.set(id, lvl);
    return lvl;
  };

  for (const st of styles.values()) {
    if (!st.isParagraph) continue;
    const lvl = levelOf(st.id);
    if (lvl !== null && lvl >= 0 && lvl <= 8) out.set(st.id, lvl + 1);
  }
  return out;
}

/** The canonical fallback when a doc ships no usable styles.xml. */
export function defaultHeadingLevels(): Map<string, number> {
  return new Map([['Heading1', 1], ['Heading2', 2], ['Heading3', 3], ['Heading4', 4]]);
}

// ── Whole-document text extraction (Analyze Round's input) ───────────────────
// Returns both the full text and the token-saving subset: every heading, the
// cite line after each tag, and — from body paragraphs — only the runs that are
// underlined or cyan/yellow/green highlighted, i.e. the parts actually read
// aloud. See DEBATE_DOC_STRUCTURE.md in the Warroom repo for the document model.
export function extractDocText(xml: string, headingLevels: Map<string, number>): { full: string; tokenSaving: string } {
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const getStyle = (p: string) => (p.match(/w:pStyle\s+w:val="([^"]+)"/) ?? [])[1] ?? 'Normal';
  const levelOfStyle = (style: string) => headingLevels.get(style) ?? 0;

  const extractEmphasized = (p: string): string =>
    [...p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)]
      .filter((r) => {
        const s = r[0];
        const hasUnderline = /<w:u\b[^>]*w:val="(?!none)[^"]*"/.test(s);
        const hasHighlight = /w:val="cyan"|w:val="yellow"|w:val="green"/.test(s);
        return hasUnderline || hasHighlight;
      })
      .map((r) => strip(r[0]))
      .filter(Boolean)
      .join(' ');

  const paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)];

  // The deepest heading level present is the TAG level — the paragraph after a
  // tag is the cite. Compute it up front; don't assume level 4.
  let maxLevel = 0;
  for (const m of paras) maxLevel = Math.max(maxLevel, levelOfStyle(getStyle(m[0])));

  const fullLines: string[] = [];
  const tokenLines: string[] = [];
  let nextIsCite = false;

  for (const m of paras) {
    const p = m[0];
    const text = strip(p);
    if (!text) continue;
    const level = levelOfStyle(getStyle(p));
    if (level > 0) {
      fullLines.push(text);
      tokenLines.push(text);
      nextIsCite = level === maxLevel;
    } else {
      fullLines.push(text);
      if (nextIsCite) {
        tokenLines.push(text);
        nextIsCite = false;
      } else {
        const emph = extractEmphasized(p);
        if (emph) tokenLines.push(emph);
      }
    }
  }

  return { full: fullLines.join('\n'), tokenSaving: tokenLines.join('\n') };
}
