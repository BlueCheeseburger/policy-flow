// Structured tag+cite extraction for Auto Flow. Unlike speechdoc:extract in
// main.ts (which flattens everything to a joined string), this keeps the
// heading HIERARCHY: each card comes back with its pocket/hat/block ancestor
// text, not just its own tag. That's what Auto Flow needs to route a card to
// the right speech column (from the pocket label) and the right flow tab
// (from the hat/block). See DEBATE_DOC_STRUCTURE.md §1–2 for the document
// model this mirrors.
//
// A bare tag with no Normal paragraph under it is an analytic/label heading,
// not an evidence card (§2) — skipped here, same as speechdoc:extract's cite
// detection in main.ts.
//
// NEVER reads card body: only headings + the first paragraph after a tag (the
// cite) are read. Auto Flow's whole point is routing tags, not re-cutting
// cards — see the CLAUDE.md instruction this feature was built against.
//
// Pulled out of main.ts as a pure function (XML strings in, data out — no
// fs/JSZip/ipcMain) so scripts/test-docx-flow-cards.ts can exercise the
// heading-collapse logic headlessly. The IPC handler (speechdoc:extractBlocks,
// main.ts) does the file I/O and calls this.

export interface ExtractedFlowCard {
  pocket: string | null;
  hat: string | null;
  block: string | null;
  tag: string;
  cite: string;
  // Only populated when extractFlowCardsFromXml is called with includeBody=true
  // — the card's evidence body (every Normal paragraph after the cite, up to the
  // next heading), capped. Used ONLY by the opt-in AI-summary path; the default
  // Auto Flow path never requests it, preserving the "routes tags, never reads
  // bodies" invariant. Even when requested, bodies stay in the main process (the
  // summarize handler consumes them and returns only short summaries).
  body?: string;
}

const BODY_CAP = 4000; // chars per card — enough for a good summary, bounds payload

/**
 * Decode the five XML predefined entities plus numeric character references.
 * `&amp;` is deliberately decoded LAST so `&amp;lt;` yields the literal text
 * `&lt;` rather than being double-decoded into `<`.
 */
export function decodeXmlEntities(s: string): string {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

export function extractFlowCardsFromXml(
  xml: string,
  headingLevels: Map<string, number>,
  includeBody = false,
): ExtractedFlowCard[] {
  // Tags must come OFF and entities must come OUT. Stripping tags without
  // decoding entities leaves `&amp;` / `&lt;&lt;` sitting in the text, and this
  // is the only source of tag and cite text now that placements are index-keyed
  // (the model no longer retypes them) — so an undecoded `&` reaches the flow
  // cell, gets escaped again by buildCellHtml, and renders as a literal
  // "&amp;". Measured on real speech docs: 116 of 833 cites and 3 taglines.
  const strip = (s: string) => decodeXmlEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  const getStyle = (p: string) => (p.match(/w:pStyle\s+w:val="([^"]+)"/) ?? [])[1] ?? 'Normal';
  const levelOfStyle = (style: string) => headingLevels.get(style) ?? 0;

  const paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)];
  let maxLevel = 0;
  for (const paraMatch of paras) maxLevel = Math.max(maxLevel, levelOfStyle(getStyle(paraMatch[0])));
  if (maxLevel === 0) return [];

  // Real docs skip heading levels (H1 straight to H4, no H2/H3 used) — collapse
  // the DISTINCT levels present to consecutive depths, same approach as the
  // viewer's outline panel (SpeechDocViewer.tsx, "Collapse level gaps"), so a
  // doc using only two levels still gets pocket→tag instead of pocket→(empty
  // hat)→(empty block)→tag.
  const levelsPresent = new Set<number>();
  for (const paraMatch of paras) {
    const lvl = levelOfStyle(getStyle(paraMatch[0]));
    if (lvl > 0) levelsPresent.add(lvl);
  }
  const depths = [...levelsPresent].sort((a, b) => a - b);
  const depthOf = (lvl: number) => depths.indexOf(lvl);
  const tagDepth = depths.length - 1; // deepest present level = the tag
  const ancestorSlots = tagDepth; // depths 0..tagDepth-1 are ancestors

  // role(depth) assigns pocket/hat/block to ancestor depths, counted from the
  // SHALLOW end — pocket first. This matters most for the sparse cases: a doc
  // with only ONE ancestor level (e.g. bare "1AC"/"2NC" headings directly above
  // tags, extremely common in disclosed docs with no hat/block breakdown) must
  // call that level "pocket", since Auto Flow's speech-column routing reads
  // card.pocket for the "1AC"/"2NC" label — mislabeling it "block" would leave
  // pocket null and break routing for exactly the doc shape that matters most.
  // Only when there are MORE than 3 ancestor levels (rare) do the two closest
  // to the tag become hat/block and everything shallower collapses into pocket.
  function roleOf(depth: number): 'pocket' | 'hat' | 'block' | null {
    if (ancestorSlots <= 0) return null;
    if (ancestorSlots === 1) return depth === 0 ? 'pocket' : null;
    if (ancestorSlots === 2) return depth === 0 ? 'pocket' : 'hat';
    if (depth === ancestorSlots - 1) return 'block';
    if (depth === ancestorSlots - 2) return 'hat';
    return 'pocket';
  }

  const ancestors: { pocket: string | null; hat: string | null; block: string | null } = { pocket: null, hat: null, block: null };
  const cards: ExtractedFlowCard[] = [];
  let pendingTag: string | null = null;
  let pendingAncestors: typeof ancestors | null = null;
  // When includeBody, the card currently accumulating body paragraphs (all the
  // Normal paragraphs after its cite, up to the next heading).
  let bodyCard: ExtractedFlowCard | null = null;

  for (const paraMatch of paras) {
    const p = paraMatch[0];
    const text = strip(p);
    if (!text) continue;
    const level = levelOfStyle(getStyle(p));

    if (level > 0) {
      // A new heading closes out any tag still waiting for its cite — a bare
      // tag with nothing under it is a label, not a card (drop it) — and ends
      // the previous card's body accumulation.
      pendingTag = null;
      pendingAncestors = null;
      bodyCard = null;

      const depth = depthOf(level);
      if (depth === tagDepth) {
        pendingTag = text;
        pendingAncestors = { ...ancestors };
      } else {
        const role = roleOf(depth);
        if (role) {
          ancestors[role] = text;
          // A new hat/pocket heading starts a fresh block/hat under it.
          if (role === 'pocket') { ancestors.hat = null; ancestors.block = null; }
          else if (role === 'hat') { ancestors.block = null; }
        }
      }
    } else if (pendingTag !== null && pendingAncestors) {
      // First Normal paragraph after a tag = the cite.
      const card: ExtractedFlowCard = { ...pendingAncestors, tag: pendingTag, cite: text };
      if (includeBody) card.body = '';
      cards.push(card);
      bodyCard = includeBody ? card : null;
      pendingTag = null;
      pendingAncestors = null;
    } else if (includeBody && bodyCard && (bodyCard.body?.length ?? 0) < BODY_CAP) {
      // Subsequent Normal paragraphs are the card body — collected only when
      // includeBody is set (the opt-in summary path).
      bodyCard.body = ((bodyCard.body ? bodyCard.body + ' ' : '') + text).slice(0, BODY_CAP);
    }
  }

  return cards;
}
