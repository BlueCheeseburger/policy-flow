// pf-send-card — broadcasts a tagline+author/date from CardMirror into the
// open PolicyDebateFlow tab that belongs to the token holder.
//
// POST /functions/v1/pf-send-card
// Authorization: Bearer <raw_token>
// Content-Type: application/json
// Body: { taglineText: string, authorDate: string, sheetId?: string,
//         targetRow?: number, targetCol?: number }
//
// The flow tab must be subscribed to the Supabase Realtime channel
// `pf:user:<userId>` and listening for broadcast event `pf-card`.
//
// 200 { ok: true }
// 401 bad/unknown token
// 422 missing required fields
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
    const { taglineText, authorDate, sheetId, targetRow, targetCol } = body ?? {};
    if (!taglineText || !authorDate) {
      return new Response(JSON.stringify({ error: 'taglineText and authorDate are required' }), { status: 422, headers: { ...CORS, 'content-type': 'application/json' } });
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

    // If the caller didn't supply row/col, read from the latest presence row.
    let row = typeof targetRow === 'number' ? targetRow : null;
    let col = typeof targetCol === 'number' ? targetCol : null;
    let resolvedSheetId = sheetId ?? null;

    if (row === null || col === null) {
      const { data: presence } = await admin
        .from('pf_flow_presence')
        .select('focused_row, focused_col, sheet_id')
        .eq('user_id', tokenRow.owner_id)
        .maybeSingle();
      if (presence) {
        if (row === null) row = presence.focused_row;
        if (col === null) col = presence.focused_col;
        if (!resolvedSheetId) resolvedSheetId = presence.sheet_id;
      }
    }

    // Broadcast via Supabase Realtime REST API (server-side broadcast).
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
          topic: `realtime:pf:user:${tokenRow.owner_id}`,
          event: 'pf-card',
          payload: { taglineText, authorDate, sheetId: resolvedSheetId, targetRow: row, targetCol: col },
        }],
      }),
    });

    if (!broadcastRes.ok) {
      const txt = await broadcastRes.text();
      return new Response(JSON.stringify({ error: `Broadcast failed: ${txt}` }), { status: 500, headers: { ...CORS, 'content-type': 'application/json' } });
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'content-type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, 'content-type': 'application/json' } });
  }
});
