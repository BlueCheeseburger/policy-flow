// pf-send-card — an HTTP way to put cards into the open Policy Flow tab of the
// token holder, for clients that can't hold a Realtime socket. The CardMirror
// plugin doesn't use this (it talks to the tab directly and gets an ack —
// see src/lib/cardMirrorLink.ts); this is the fire-and-forget equivalent.
//
// POST /functions/v1/pf-send-card
// Authorization: Bearer <raw_token>
// Content-Type: application/json
// Body: { cards: [{ kind: 'card' | 'heading', text, cite?, source? }] }
//   or, the original single-card shape: { taglineText: string, authorDate?: string }
//
// Broadcasts event `pf-cards` on the private channel `pf:cm:<sha256(token)>`,
// which every open flow tab of the token's owner subscribes to; the tab the
// user last focused applies it.
//
// 200 { ok: true, count }
// 401 bad/unknown token
// 422 no usable cards
// 500 internal

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

async function hashToken(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const auth = req.headers.get('authorization') ?? '';
    const rawToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!rawToken) return new Response(JSON.stringify({ error: 'Missing token' }), { status: 401, headers: { ...CORS, 'content-type': 'application/json' } });

    const body = await req.json().catch(() => null);
    const cards = Array.isArray(body?.cards)
      ? body.cards
      : body?.taglineText ? [{ kind: 'card', text: body.taglineText, ...(body.authorDate ? { cite: body.authorDate } : {}) }] : [];
    const clean = cards
      .filter((c: any) => c && (c.kind === 'card' || c.kind === 'heading') && typeof c.text === 'string' && c.text.trim())
      .slice(0, 500)
      .map((c: any) => ({
        kind: c.kind,
        text: String(c.text).slice(0, 2000),
        ...(typeof c.cite === 'string' && c.cite.trim() ? { cite: c.cite.slice(0, 400) } : {}),
        ...(typeof c.source === 'string' && /^cmsrc[0-9]{1,3}\.[A-Za-z0-9_-]{1,8000}$/.test(c.source) ? { source: c.source } : {}),
      }));
    if (!clean.length) {
      return new Response(JSON.stringify({ error: 'No cards to send' }), { status: 422, headers: { ...CORS, 'content-type': 'application/json' } });
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const hashed = await hashToken(rawToken);
    const { data: tokenRow } = await admin
      .from('pf_api_tokens')
      .select('owner_id')
      .eq('token_hash', hashed)
      .maybeSingle();

    if (!tokenRow) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { ...CORS, 'content-type': 'application/json' } });

    // Realtime's REST broadcast takes the BARE topic — the `realtime:` prefix
    // is what the client library adds on join. This function used to send
    // `realtime:pf:user:<uid>`, a topic nothing subscribes to, so every send
    // returned 200 and delivered nothing.
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const broadcastRes = await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{
          topic: `pf:cm:${hashed}`,
          event: 'pf-cards',
          payload: { id: crypto.randomUUID(), cards: clean },
        }],
      }),
    });

    if (!broadcastRes.ok) {
      const txt = await broadcastRes.text();
      return new Response(JSON.stringify({ error: `Broadcast failed: ${txt}` }), { status: 500, headers: { ...CORS, 'content-type': 'application/json' } });
    }

    return new Response(JSON.stringify({ ok: true, count: clean.length }), { headers: { ...CORS, 'content-type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, 'content-type': 'application/json' } });
  }
});
