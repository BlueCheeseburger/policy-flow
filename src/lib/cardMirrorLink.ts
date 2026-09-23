// The wire protocol between the CardMirror plugin (cardmirror-plugin/) and an
// open flow tab. Both sides import THIS file — the plugin is bundled from it —
// so the message shapes can't drift apart.
//
// Transport: one Supabase Realtime broadcast channel per pairing, named by the
// SHA-256 of the pairing token. The plugin holds the token and hashes it; the
// flow tab reads the hash back from pf_api_tokens (RLS: owner only). Nobody
// else can learn the channel name — unlike the old `pf:user:<uid>` channel,
// whose name every co-flower in a shared room could see (uids are the live
// presence keys), and which the anon key alone could broadcast into.
//
// Every request carries an id and gets an ack from the tab that handled it,
// so the plugin reports what actually happened ("Sent 6 to 1AC") instead of
// "the server accepted a broadcast" — which is all the old Edge Function path
// could ever say, and why it kept reporting success while no card arrived (it
// broadcast to `realtime:pf:user:…`, a topic nothing was subscribed to).

export const CM_CARDS_EVENT = 'pf-cards';
export const CM_CARDS_ACK_EVENT = 'pf-cards-ack';
export const CM_JUMP_EVENT = 'pf-jump';
export const CM_JUMP_ACK_EVENT = 'pf-jump-ack';

/** How long either side waits for the other's ack before calling it silent. */
export const CM_ACK_TIMEOUT_MS = 4000;

/** CardMirror's opaque provenance token (`cmsrc1.<base64url>`). Never parsed here. */
export const CM_SOURCE_RE = /^cmsrc[0-9]{1,3}\.[A-Za-z0-9_-]{1,8000}$/;

export function isCmSource(s: unknown): s is string {
  return typeof s === 'string' && CM_SOURCE_RE.test(s);
}

export function cmTopic(tokenHash: string): string {
  return `pf:cm:${tokenHash}`;
}

/** Hex SHA-256 — identical to the Edge Functions' hashToken and pf_api_tokens.token_hash. */
export async function sha256Hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Messages ────────────────────────────────────────────────────────────────

export interface CmCard {
  /** `heading` = a pocket/hat/block title; `card` = a tag or analytic. */
  kind: 'heading' | 'card';
  text: string;
  /** Short cite (author + date). Only on cards, and only when the card has one. */
  cite?: string;
  /** CardMirror source token — what right-click hands back to jump to it. */
  source?: string;
}

export interface CmCardsMsg { id: string; cards: CmCard[] }

/** What the tab did with a batch. */
export type CmCardsResult =
  | { ok: true; placed: number; flowName: string; sheetName: string }
  | { ok: false; error: 'paused' | 'grid-full' | 'bad-request' };

export type CmCardsAck = CmCardsResult & { id: string };

export interface CmJumpMsg { id: string; source: string }

export type CmJumpAck =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string; docTitle?: string };

// ── Extraction → cards ──────────────────────────────────────────────────────

/** The subset of CardMirror's ExtractedItem this needs (plugin API §3). */
export interface ExtractedItemLike {
  kind: 'pocket' | 'hat' | 'block' | 'tag' | 'analytic' | 'undertag' | 'cite';
  text: string;
  source: string;
}

const MAX_TEXT = 2000;
const MAX_CITE = 400;

/**
 * Turn CardMirror's flat extraction (document order) into flow rows.
 *
 * With the cursor on a pocket, hat, or block, extraction already spans
 * everything under it, so this is what makes "send the whole block" work:
 * every tag/analytic becomes its own row carrying the first cite found inside
 * it, and — when `includeHeadings` — each pocket/hat/block title becomes a row
 * too, so the flow keeps the doc's structure. Undertags are dropped: they're
 * card-body commentary, not something a flow records.
 */
export function itemsToCards(items: readonly ExtractedItemLike[], opts: { includeHeadings: boolean }): CmCard[] {
  const out: CmCard[] = [];
  let current: CmCard | null = null;
  for (const it of items) {
    const text = String(it.text ?? '').trim().slice(0, MAX_TEXT);
    if (!text) continue;
    const source = isCmSource(it.source) ? it.source : undefined;
    switch (it.kind) {
      case 'pocket': case 'hat': case 'block':
        current = null;
        if (opts.includeHeadings) out.push({ kind: 'heading', text, ...(source ? { source } : {}) });
        break;
      case 'tag': case 'analytic':
        current = { kind: 'card', text, ...(source ? { source } : {}) };
        out.push(current);
        break;
      case 'cite':
        // A cite always follows its own card's tag in document order; one that
        // arrives with no open card (a stray top-level cite) has nothing to
        // attach to, and a second cite in the same card is a quals line.
        if (current && !current.cite) current.cite = text.slice(0, MAX_CITE);
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Split a send into messages that stay under Realtime's per-message size cap
 * (256 KB on hosted Supabase — kept well clear of it). Order is preserved, and
 * the tab applies chunks in arrival order, which one socket guarantees.
 */
export function chunkCards(cards: CmCard[], maxBytes = 96_000, maxCount = 80): CmCard[][] {
  const chunks: CmCard[][] = [];
  let cur: CmCard[] = [];
  let bytes = 0;
  for (const c of cards) {
    const size = JSON.stringify(c).length;
    if (cur.length && (bytes + size > maxBytes || cur.length >= maxCount)) { chunks.push(cur); cur = []; bytes = 0; }
    cur.push(c);
    bytes += size;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ── Card → cell HTML ────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The HTML a sent card becomes in its cell. The tagline sits in a
 * `<span data-cm>` carrying the source token, which is what right-click reads
 * to jump back to the card — it travels with the text through moves, copy and
 * paste, and live sync. Built from escaped text only, then still run through
 * the cell sanitizer by the caller, so nothing from the wire becomes markup.
 */
export function cardCellHtml(card: CmCard): string {
  const src = card.source && isCmSource(card.source) ? ` data-cm="${esc(card.source)}"` : '';
  const main = `<span${src}>${esc(card.text)}</span>`;
  if (card.kind === 'heading') return `<u>${main}</u>`;
  return card.cite ? `${main} — ${esc(card.cite)}` : main;
}

/** Validate an inbound cards message; returns null for anything malformed. */
export function parseCardsMsg(raw: unknown): CmCardsMsg | null {
  const m = raw as Partial<CmCardsMsg> | null;
  if (!m || typeof m.id !== 'string' || !Array.isArray(m.cards) || m.cards.length === 0 || m.cards.length > 500) return null;
  const cards: CmCard[] = [];
  for (const c of m.cards as any[]) {
    if (!c || (c.kind !== 'heading' && c.kind !== 'card') || typeof c.text !== 'string' || !c.text.trim()) return null;
    cards.push({
      kind: c.kind,
      text: c.text.slice(0, MAX_TEXT),
      ...(typeof c.cite === 'string' && c.cite.trim() ? { cite: c.cite.slice(0, MAX_CITE) } : {}),
      ...(isCmSource(c.source) ? { source: c.source } : {}),
    });
  }
  return { id: m.id.slice(0, 64), cards };
}
