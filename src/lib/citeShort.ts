// Turning a full Verbatim cite paragraph into the short cite a debater says out
// loud — "Cutler & Klarnet '26", not the author's job title and university.
//
// Auto Flow asks Warroom AI for this (rule 3 of auto_flow_classify.txt), but the
// model sometimes omits the field, and the fallback used to be the FULL cite
// paragraph — the exact wall of text the prompt says to strip, dumped into a
// flow cell. This is the fallback instead. It also means a parser-only Auto Flow
// can produce usable cites with no model at all.
//
// Real cites from speech docs come in two dominant shapes:
//
//   "Toth '16 [Federico; May; University of Bologna, Dipartimento…"   → bracket
//   "Ralph Nader 25, Former presidential candidate, American lawyer…" → comma
//
// Both put the short cite first and the quals after a delimiter, so the parse is
// "take everything before the first [ or , then reduce it to surname + year".
//
// Run the tests:  npx tsx scripts/test-cite-short.ts

/** Honorifics and post-nominals that are never part of a spoken short cite. */
const HONORIFIC = /^(dr|prof|professor|mr|mrs|ms|mx|sir|rev|hon|amb|gen|col|capt|lt|sen|rep|judge)\.?$/i;
const POSTNOMINAL = /^(phd|ph\.d|jd|j\.d|md|m\.d|mba|ma|ba|bs|msc|llm|ll\.m|esq|cpa|cfp)\.?,?$/i;

/**
 * A year as it appears in a cite: `'26`, `’26`, `26`, `2026`, Verbatim's
 * month-day form for a current-year source (`'7/1`, `’6-25`), or the `'2k`
 * shorthand for 2000. Without the last one, `Hampton ‘2k` lost its surname —
 * `'2k` wasn't recognised as a year, so it was taken as the name instead.
 */
const YEAR = /^['’‘]?(\d{1,4}([/-]\d{1,2})?|\dk)$/i;

function isYear(token: string): boolean {
  return YEAR.test(token.replace(/[.,;]+$/, ''));
}

/** Normalise the assorted apostrophes debate docs use into a plain one. */
function tidy(s: string): string {
  return s.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * Best-effort short cite. Returns '' when there is nothing usable — a
 * `<<FOR REFERENCE>>` marker, an empty cite — so the caller can leave the cite
 * line off rather than printing a placeholder.
 */
export function shortCite(full: string): string {
  const raw = tidy(String(full ?? '')).replace(/^[\s,;:.\-–—]+/, '');
  if (!raw) return '';

  // `<<...FOR REFERENCE>>` marks a card already read earlier in the round; it
  // carries no author, so there is no short cite to make.
  if (/^<<.*>>$/.test(raw) || /FOR REFERENCE/i.test(raw)) return '';

  // Everything before the first bracket or comma is the short-cite head in both
  // dominant shapes. Whichever comes first wins.
  const cutAt = [raw.indexOf('['), raw.indexOf('('), raw.indexOf(',')]
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  let head = (cutAt === undefined ? raw : raw.slice(0, cutAt)).trim();
  head = head.replace(/[;:,.\s]+$/, '');
  if (!head) return '';

  let tokens = head.split(' ').filter(Boolean)
    .filter((t) => !HONORIFIC.test(t) && !POSTNOMINAL.test(t));
  if (tokens.length === 0) return '';

  // Trailing year, if the head carries one.
  let year = '';
  if (isYear(tokens[tokens.length - 1])) {
    year = tokens.pop()!.replace(/[.,;]+$/, '');
  }

  // "et al" — keep it, and treat the name immediately before it as the surname.
  const etAlAt = tokens.findIndex((t, i) =>
    /^et$/i.test(t) && i + 1 < tokens.length && /^al\.?,?$/i.test(tokens[i + 1]));
  let etAl = false;
  if (etAlAt !== -1) { etAl = true; tokens = tokens.slice(0, etAlAt); }

  // Multiple authors joined by & or "and" — keep every surname, since that is
  // how the cite is actually said ("Cutler & Klarnet").
  const joiner = tokens.findIndex((t) => t === '&' || /^and$/i.test(t));
  let name: string;
  if (joiner > 0 && joiner < tokens.length - 1) {
    const left = tokens.slice(0, joiner);
    const right = tokens.slice(joiner + 1);
    name = `${surnameOf(left)} & ${surnameOf(right)}`;
  } else {
    name = surnameOf(tokens);
  }
  if (!name) return '';

  // Evidence check. A head with NO year and no delimiter before it is just
  // arbitrary leading prose — there is nothing marking it as a cite, and
  // guessing a surname out of it produces junk like "here" from ", just quals
  // here". A year, or a bracket/comma the head sits in front of, is what makes
  // this a cite head rather than a sentence.
  if (!year && cutAt === undefined) return '';

  const parts = [name];
  if (etAl) parts.push('et al.');
  if (year) parts.push(year.startsWith("'") ? year : `'${year.replace(/^'/, '')}`);
  return parts.join(' ');
}

/**
 * The surname out of a name run. Given names come first in every cite shape we
 * see, so the LAST token is the surname — except for a particle-led surname
 * ("van der Berg", "de Souza"), where the particle starts it.
 */
const PARTICLE = /^(van|von|der|den|de|del|della|di|da|du|la|le|el|al|bin|ibn|st\.?)$/i;

function surnameOf(tokens: string[]): string {
  const clean = tokens.filter(Boolean).map((t) => t.replace(/[.,;]+$/, '')).filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0];
  // Walk back over particles so "van der Berg" survives whole.
  let start = clean.length - 1;
  while (start > 0 && PARTICLE.test(clean[start - 1])) start--;
  // An all-caps or clearly organisational head ("Partnership For America's…")
  // has no surname to pick — keep it as written, trimmed to something sayable.
  if (start === 0) return clean.join(' ');
  return clean.slice(start).join(' ');
}
