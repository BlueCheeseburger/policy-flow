// pf-presence — returns the current focus state of a PolicyDebateFlow tab for
// a user identified by a CardMirror API token.
//
// GET /functions/v1/pf-presence
// Authorization: Bearer <raw_token>
//
// Response (200):
//   { flowId, flowName, sheetId, sheetName, focusedRow, focusedCol, updatedAt }
//   or { present: false } when no tab has written presence recently,
//   or { present: false, paused: true } when a tab IS open but the user
//   paused delivery via the status chip — distinct from "not open at all".
//
// Error responses: 401 (bad/unknown token), 500 (internal).

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

    const { data: presence } = await admin
      .from('pf_flow_presence')
      .select('flow_id, flow_name, sheet_id, sheet_name, focused_row, focused_col, paused, updated_at')
      .eq('user_id', tokenRow.owner_id)
      .maybeSingle();

    if (!presence) {
      return new Response(JSON.stringify({ present: false }), { headers: { ...CORS, 'content-type': 'application/json' } });
    }

    // Treat stale presence (>5 min since the pause, or since the last real
    // focus write) as absent — same rule either way, since a paused-and-then-
    // abandoned tab looks identical to an idle-and-then-closed one: nothing
    // has refreshed this row since. Only a RECENT pause is reported as such.
    const age = Date.now() - new Date(presence.updated_at).getTime();
    if (age > 5 * 60 * 1000) {
      return new Response(JSON.stringify({ present: false }), { headers: { ...CORS, 'content-type': 'application/json' } });
    }

    if (presence.paused) {
      return new Response(JSON.stringify({ present: false, paused: true }), { headers: { ...CORS, 'content-type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      present: true,
      flowId: presence.flow_id,
      flowName: presence.flow_name,
      sheetId: presence.sheet_id,
      sheetName: presence.sheet_name,
      focusedRow: presence.focused_row,
      focusedCol: presence.focused_col,
      updatedAt: presence.updated_at,
    }), { headers: { ...CORS, 'content-type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, 'content-type': 'application/json' } });
  }
});
