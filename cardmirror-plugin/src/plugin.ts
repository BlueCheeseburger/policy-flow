// Policy Flow — CardMirror plugin.
//
// Sends taglines (or everything under a pocket/hat/block) from CardMirror into
// the open Policy Flow sheet, and answers "jump to this card" requests from a
// right-click in the flow. Built by scripts/build-plugin.mjs into one
// plugin.js; the manifest sits next to it. CardMirror's plugin contract:
// reference-docs/cardmirror-plugin-api.md in the CardMirror repo.
//
// Transport is the private Realtime channel described in
// src/lib/cardMirrorLink.ts — imported here, so the plugin and the web app
// share one definition of every message.

import { RealtimeClient, type RealtimeChannel } from '@supabase/realtime-js';
import {
  CM_ACK_TIMEOUT_MS, CM_CARDS_ACK_EVENT, CM_CARDS_EVENT, CM_JUMP_ACK_EVENT, CM_JUMP_EVENT,
  chunkCards, cmTopic, isCmSource, itemsToCards, sha256Hex,
  type CmCardsAck, type CmJumpAck, type ExtractedItemLike,
} from '../../src/lib/cardMirrorLink';

// Injected at build time from the web app's own .env — the same public,
// RLS-protected anon key the site ships to every browser.
declare const __PF_SUPABASE_URL__: string;
declare const __PF_SUPABASE_ANON_KEY__: string;
declare const __PF_PLUGIN_VERSION__: string;

const PLUGIN_ID = 'policy-flow';
const APP_URL = 'policydebateflow.vercel.app';

// ── The slice of CardMirror's plugin API this uses (plugin API §3) ──────────

type JumpResult = { ok: true } | { ok: false; error: string; docTitle?: string };
interface Api {
  readonly appVersion: string;
  extractSelection():
    | { ok: true; docId: string; docTitle: string; items: ExtractedItemLike[] }
    | { ok: false; error: 'no-heading-at-cursor' | 'no-active-doc' | 'empty-selection' };
  jumpToSource(token: string): Promise<JumpResult>;
  showToast(message: string): void;
  storage: { get(key: string): unknown; set(key: string, value: unknown): void };
  settings: {
    get(key: string): boolean | string | number | undefined;
    onChanged?(cb: (key: string, value: boolean | string | number) => void): () => void;
  };
}

let api: Api | null = null;

function pairingToken(): string {
  const fromApi = api?.settings.get('token');
  if (typeof fromApi === 'string') return fromApi.trim();
  // Before CardMirror hands us an api (builds without activate(), until the
  // first command runs), read the declared setting straight from the plugin's
  // storage bag so jump requests can still be heard and answered "not ready".
  try {
    const bag = JSON.parse(localStorage.getItem(`plugin:${PLUGIN_ID}`) || '{}');
    const t = bag?.__settings?.token;
    return typeof t === 'string' ? t.trim() : '';
  } catch { return ''; }
}

function isPaused(): boolean {
  return api?.storage.get('paused') === true;
}

// ── Connection ──────────────────────────────────────────────────────────────

interface Conn {
  hash: string;
  client: RealtimeClient;
  channel: RealtimeChannel;
  ready: Promise<boolean>;
}
let conn: Conn | null = null;
let connecting: Promise<Conn | null> | null = null;
const cardWaiters = new Map<string, (ack: CmCardsAck) => void>();

function teardown() {
  if (!conn) return;
  const { client, channel } = conn;
  conn = null;
  void client.removeChannel(channel).finally(() => client.disconnect());
}

/** Open (or reuse) the channel for the current pairing code. Null when unpaired. */
async function connect(): Promise<Conn | null> {
  const token = pairingToken();
  if (!token) { teardown(); return null; }
  const hash = await sha256Hex(token);
  if (conn?.hash === hash) return conn;
  if (connecting) return connecting;
  connecting = (async () => {
    teardown();
    const client = new RealtimeClient(`${__PF_SUPABASE_URL__.replace(/^http/, 'ws')}/realtime/v1`, {
      params: { apikey: __PF_SUPABASE_ANON_KEY__ },
    });
    const channel = client.channel(cmTopic(hash), { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: CM_CARDS_ACK_EVENT }, ({ payload }) => {
      const done = typeof payload?.id === 'string' ? cardWaiters.get(payload.id) : undefined;
      if (done) { cardWaiters.delete(payload.id); done(payload as CmCardsAck); }
    });
    channel.on('broadcast', { event: CM_JUMP_EVENT }, ({ payload }) => { void handleJump(channel, payload); });
    const ready = new Promise<boolean>((resolve) => {
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve(true);
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') resolve(false);
      });
    });
    conn = { hash, client, channel, ready };
    return conn;
  })().finally(() => { connecting = null; });
  return connecting;
}

/**
 * A channel that's actually joined right now. A dropped socket rejoins on its
 * own, so give it a moment; one that stays down (or never subscribed) is torn
 * down and rebuilt once, rather than every later send failing on a dead
 * connection — or worse, timing out and blaming "no flow open".
 */
async function joinedConn(): Promise<Conn | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = await connect();
    if (!c) return null;
    if (await c.ready) {
      for (let waited = 0; waited < 3000 && c.channel.state !== 'joined'; waited += 150) {
        await new Promise((r) => setTimeout(r, 150));
      }
      if (c.channel.state === 'joined') return c;
    }
    if (conn === c) teardown();
  }
  return null;
}

async function handleJump(channel: RealtimeChannel, payload: any) {
  const id = typeof payload?.id === 'string' ? payload.id : null;
  if (!id) return;
  const reply = (ack: CmJumpAck) => { void channel.send({ type: 'broadcast', event: CM_JUMP_ACK_EVENT, payload: ack }); };
  if (!isCmSource(payload.source)) { reply({ id, ok: false, error: 'bad-request' }); return; }
  if (!api) { reply({ id, ok: false, error: 'not-ready' }); return; }
  let res: JumpResult;
  try { res = await api.jumpToSource(payload.source); }
  catch (e) { res = { ok: false, error: e instanceof Error ? e.message : 'failed' }; }
  reply({ id, ...res } as CmJumpAck);
  if (!res.ok && res.error === 'doc-not-open') {
    api.showToast(res.docTitle ? `Open “${res.docTitle}” to jump to that card.` : 'Open that document to jump to the card.');
  }
}

function sendChunk(channel: RealtimeChannel, cards: ReturnType<typeof itemsToCards>): Promise<CmCardsAck | null> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cardWaiters.delete(id); resolve(null); }, CM_ACK_TIMEOUT_MS);
    cardWaiters.set(id, (ack) => { clearTimeout(timer); resolve(ack); });
    void channel.send({ type: 'broadcast', event: CM_CARDS_EVENT, payload: { id, cards } });
  });
}

/**
 * Nobody acked a send. Ask the server why, so the toast names the actual
 * problem: a dead pairing code, a paused flow, or no flow open at all.
 */
async function explainSilence(token: string): Promise<string> {
  try {
    const res = await fetch(`${__PF_SUPABASE_URL__}/functions/v1/pf-presence`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) return 'That pairing code no longer works. Make a new one in Policy Flow → Settings → CardMirror.';
    const body = await res.json().catch(() => ({}));
    if (body?.paused) return 'Policy Flow is paused. Click “CardMirror: Paused” in the flow to resume.';
  } catch { /* offline — fall through to the generic hint */ }
  return `No flow is open. Open one at ${APP_URL} and click into the column you want.`;
}

// ── Commands ────────────────────────────────────────────────────────────────

function adoptApi(a: Api) {
  if (api === a) return;
  api = a;
  // The pairing code may have arrived through the settings gear since the
  // bag was last read; reconnect against whatever is current.
  void connect();
}

async function sendToFlow(a: Api) {
  adoptApi(a);
  if (isPaused()) { a.showToast('Sending to Policy Flow is paused. Run “Policy Flow: Resume sending” to turn it back on.'); return; }
  const token = pairingToken();
  if (!token) {
    a.showToast('Add your pairing code first: Settings → Plugins → Policy Flow (gear). Get one in Policy Flow → Settings → CardMirror.');
    return;
  }
  const ext = a.extractSelection();
  if (!ext.ok) {
    a.showToast(
      ext.error === 'no-active-doc' ? 'Open a document first.'
        : ext.error === 'no-heading-at-cursor' ? 'Put the cursor on a tag, or on a pocket, hat, or block to send everything under it.'
          : 'Nothing to send there.',
    );
    return;
  }
  const cards = itemsToCards(ext.items, { includeHeadings: a.settings.get('includeHeadings') !== false });
  if (!cards.length) { a.showToast('No tags or analytics there to send.'); return; }

  const c = await joinedConn();
  if (!c) { a.showToast("Couldn't reach Policy Flow's server. Check your connection."); return; }

  let placed = 0;
  let where = '';
  for (const chunk of chunkCards(cards)) {
    const ack = await sendChunk(c.channel, chunk);
    if (!ack) {
      a.showToast(placed ? `Sent ${placed} of ${cards.length}, then Policy Flow stopped answering.` : await explainSilence(token));
      return;
    }
    if (!ack.ok) {
      a.showToast(
        ack.error === 'paused' ? 'Policy Flow is paused. Click “CardMirror: Paused” in the flow to resume.'
          : ack.error === 'grid-full' ? 'That column is full. Pick another column or add rows in the flow.'
            : 'Policy Flow turned that send away. Update the plugin and try again.',
      );
      return;
    }
    placed += ack.placed;
    where = `${ack.sheetName} – ${ack.flowName}`;
  }
  const first = cards[0].text;
  a.showToast(placed === 1
    ? `Sent “${first.length > 48 ? first.slice(0, 47) + '…' : first}” to ${where}`
    : `Sent ${placed} rows to ${where}`);
}

function togglePause(a: Api) {
  adoptApi(a);
  const next = !isPaused();
  a.storage.set('paused', next);
  a.showToast(next ? 'Paused sending to Policy Flow.' : 'Sending to Policy Flow again.');
}

// Builds without activate(): be listening for jumps from launch anyway, using
// the stored pairing code. Jumps answer "not ready" until an api arrives.
void connect();

(window as any).__registerCardMirrorPlugin?.({
  id: PLUGIN_ID,
  name: 'Policy Flow',
  apiVersion: 1,
  settings: [
    {
      key: 'token',
      label: 'Pairing code',
      type: 'text',
      default: '',
      description: 'From Policy Flow → Settings → CardMirror → Generate pairing code.',
    },
    {
      key: 'includeHeadings',
      label: 'Send pocket, hat, and block titles as rows',
      type: 'boolean',
      default: true,
      description: 'When sending a whole section, its titles go in underlined between the cards.',
    },
  ],
  // CardMirror 1.12.0-bcb.2+: hands us the api at load, so right-click jumps
  // work before any command has run. Older builds ignore this field.
  activate(a: Api) {
    adoptApi(a);
    const off = a.settings.onChanged?.((key) => { if (key === 'token') void connect(); });
    return () => { off?.(); teardown(); };
  },
  commands: [
    {
      id: `${PLUGIN_ID}.sendToFlow`,
      label: 'Policy Flow: Send to flow',
      keywords: ['flow', 'send', 'tagline', 'policy', 'pf'],
      defaultKey: '~',
      run: sendToFlow,
    },
    {
      id: `${PLUGIN_ID}.togglePause`,
      label: 'Policy Flow: Pause or resume sending',
      keywords: ['flow', 'pause', 'resume', 'policy'],
      defaultKey: null,
      run: togglePause,
    },
  ],
});

console.log(`[policy-flow] plugin ${__PF_PLUGIN_VERSION__} loaded`);
