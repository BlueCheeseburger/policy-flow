// The cross-ex doc's model: an outline of bullet points, two levels deep, and
// nothing else. No paragraphs, no numbering, no third level — CX notes are
// questions and the answers under them, and a format that allows anything
// more ends up as a wall of prose nobody can find a concession in mid-round.
//
// Stored as plain text, one bullet per line, a leading tab marking a
// sub-bullet. That keeps it a single Y.Text in the live doc (character-level
// merges when two partners type at once) and a single string offline.

export type CxLevel = 0 | 1;
export interface CxBullet { level: CxLevel; text: string }

/** Bullets can't hold line breaks — a break IS a new bullet. */
function cleanText(s: string): string {
  return s.replace(/[\r\n\t\u2028\u2029]+/g, ' ');
}

export function parseCx(src: string): CxBullet[] {
  const out: CxBullet[] = [];
  for (const line of (src ?? '').split('\n')) {
    const sub = line.startsWith('\t');
    out.push({ level: sub ? 1 : 0, text: cleanText(sub ? line.slice(1) : line) });
  }
  return normalizeCx(out);
}

export function serializeCx(bullets: CxBullet[]): string {
  return normalizeCx(bullets).map((b) => (b.level ? '\t' : '') + cleanText(b.text)).join('\n');
}

/**
 * The invariants: never empty (there is always a bullet to type into), the
 * first bullet is top-level (a sub-point needs a parent), levels are 0 or 1.
 */
export function normalizeCx(bullets: CxBullet[]): CxBullet[] {
  const out = bullets.map((b, i) => ({ level: (i === 0 ? 0 : b.level ? 1 : 0) as CxLevel, text: b.text }));
  return out.length ? out : [{ level: 0, text: '' }];
}

// Bullet glyphs and list numbering people paste in from Docs, Word, notes
// apps, and markdown. The doc draws its own bullets, so these would double up.
const MARKER_RE = /^(?:[-*+•◦▪▫‣⁃·●○■□–—>]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)](?=\s)|\[[ xX]?\])\s*/;

/**
 * Turn pasted text into bullets. Each non-blank line is one bullet; any line
 * indented deeper than the shallowest line becomes a sub-bullet (there's no
 * third level to map deeper indents onto, so they all flatten to one).
 */
export function pastedToBullets(text: string): CxBullet[] {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const indentOf = (l: string) => {
    const ws = l.match(/^[ \t ]*/)![0];
    return ws.replace(/\t/g, '    ').length;
  };
  const base = Math.min(...lines.map(indentOf));
  return lines.map((l) => {
    let t = l.trim();
    // Strip at most two stacked markers ("- 1. point").
    for (let i = 0; i < 2 && MARKER_RE.test(t); i++) t = t.replace(MARKER_RE, '');
    return { level: (indentOf(l) > base ? 1 : 0) as CxLevel, text: cleanText(t.trim()) };
  });
}

/** Plain-text rendering for copying out of the app. */
export function cxToPlainText(bullets: CxBullet[]): string {
  return normalizeCx(bullets).filter((b) => b.text.trim()).map((b) => (b.level ? '    ◦ ' : '• ') + b.text).join('\n');
}
