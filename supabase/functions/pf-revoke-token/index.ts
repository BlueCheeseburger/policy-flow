// pf-revoke-token — lets CardMirror invalidate its own token without needing
// a browser session. Any client holding a valid raw token can delete it here.
//
// POST /functions/v1/pf-revoke-token
// Authorization: Bearer <raw_token>
//
// 200 { ok: true }
// 401 bad/unknown token
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

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const hashed = await hashToken(rawToken);
    const { data, error } = await admin
      .from('pf_api_tokens')
      .delete()
      .eq('token_hash', hashed)
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (!data) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { ...CORS, 'content-type': 'application/json' } });

    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'content-type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, 'content-type': 'application/json' } });
  }
});
