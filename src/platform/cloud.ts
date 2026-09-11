// Cloud-side flow operations: the durable snapshot table, share links, and the
// device-transfer code. Live keystroke sync is separate (see lib/flowSync.ts);
// this is the part that survives everyone closing the tab.
//
// Every function degrades to a clear failure rather than throwing into a render
// path, because flowing is local-first: a flow keeps working with no network,
// it just stops being shareable until one comes back.

import { supabase, getIdentity } from './supabase';

export interface CloudFlow {
  id: string;
  name: string;
  event: 'policy';
  updatedAt: string;
  /** Present only for flows this browser owns — a shared flow never sees it. */
  shareToken?: string;
  owned: boolean;
}

export type CloudResult<T> = { ok: true; data: T } | { ok: false; error: string };

function fail(e: any): { ok: false; error: string } {
  return { ok: false, error: e?.message || String(e) || 'Something went wrong.' };
}

async function client() {
  if (!supabase) throw new Error('Cloud sync is not configured in this build.');
  const user = await getIdentity();
  if (!user) throw new Error('Could not reach the server. Your flows are still saved on this device.');
  return { sb: supabase, userId: user.id };
}

/** Every flow this browser owns or has been granted, newest first. */
export async function listFlows(): Promise<CloudResult<CloudFlow[]>> {
  try {
    const { sb, userId } = await client();
    const { data, error } = await sb
      .from('pf_flows')
      .select('id, name, event, updated_at, share_token, owner_id')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return {
      ok: true,
      data: (data ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        event: 'policy',
        updatedAt: r.updated_at,
        owned: r.owner_id === userId,
        shareToken: r.owner_id === userId ? r.share_token : undefined,
      })),
    };
  } catch (e) { return fail(e); }
}

/**
 * Create the cloud row for a flow, using the id the flow ALREADY has locally.
 * Reusing the local id rather than taking a server-assigned one means the
 * storage key, the share link, and the realtime channel all name the same
 * thing — a flow never has two identities to reconcile.
 */
export async function createFlow(id: string, name: string, content: string | null): Promise<CloudResult<CloudFlow>> {
  try {
    const { sb, userId } = await client();
    const { data, error } = await sb
      .from('pf_flows')
      .insert({ id, owner_id: userId, name, event: 'policy', content })
      .select('id, name, updated_at, share_token')
      .single();
    if (error) throw error;
    return { ok: true, data: { id: data.id, name: data.name, event: 'policy', updatedAt: data.updated_at, shareToken: data.share_token, owned: true } };
  } catch (e) { return fail(e); }
}

/**
 * Push the durable snapshot, creating the row if this flow has never synced.
 * An upsert, so a flow made offline starts syncing the moment a connection
 * comes back — there is no separate "first save" path to get wrong.
 */
export async function saveSnapshot(flowId: string, name: string, content: string): Promise<CloudResult<{ shareToken?: string }>> {
  try {
    const { sb, userId } = await client();
    const { data, error } = await sb
      .from('pf_flows')
      // owner_id is only used by the INSERT half of this upsert; on an
      // existing row a trigger pins it back to whoever actually owns the flow,
      // so saving a room you were invited into can't quietly take it over.
      .upsert({ id: flowId, owner_id: userId, name, content }, { onConflict: 'id' })
      .select('share_token, owner_id')
      .single();
    if (error) throw error;
    // A flow someone else owns (you opened their link) has no token to give you.
    return { ok: true, data: { shareToken: data.owner_id === userId ? data.share_token : undefined } };
  } catch (e) { return fail(e); }
}

export async function loadSnapshot(flowId: string): Promise<CloudResult<{ content: string | null; name: string }>> {
  try {
    const { sb } = await client();
    const { data, error } = await sb.from('pf_flows').select('content, name').eq('id', flowId).single();
    if (error) throw error;
    return { ok: true, data: { content: data.content ?? null, name: data.name } };
  } catch (e) { return fail(e); }
}

export async function renameFlow(flowId: string, name: string): Promise<CloudResult<null>> {
  try {
    const { sb } = await client();
    const { error } = await sb.from('pf_flows').update({ name }).eq('id', flowId);
    if (error) throw error;
    return { ok: true, data: null };
  } catch (e) { return fail(e); }
}

/** Owner-only. A shared editor leaving a room removes their grant instead. */
export async function deleteFlow(flowId: string): Promise<CloudResult<null>> {
  try {
    const { sb } = await client();
    const { error } = await sb.from('pf_flows').delete().eq('id', flowId);
    if (error) throw error;
    return { ok: true, data: null };
  } catch (e) { return fail(e); }
}

export async function leaveFlow(flowId: string): Promise<CloudResult<null>> {
  try {
    const { sb, userId } = await client();
    const { error } = await sb.from('pf_flow_grants').delete().eq('flow_id', flowId).eq('user_id', userId);
    if (error) throw error;
    return { ok: true, data: null };
  } catch (e) { return fail(e); }
}

/**
 * Trade a share token for access. The token comes out of the URL fragment, so
 * it never lands in a server log or a Referer header the way a query string
 * would.
 */
export async function joinFlow(token: string): Promise<CloudResult<{ id: string; name: string }>> {
  try {
    const { sb } = await client();
    const { data, error } = await sb.rpc('pf_join_flow', { token });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.id) throw new Error('That link is not valid any more.');
    return { ok: true, data: { id: row.id, name: row.name } };
  } catch (e) { return fail(e); }
}

export function shareUrl(token: string): string {
  return `${window.location.origin}/#/join/${token}`;
}

// ── Moving to another device ─────────────────────────────────────────────────

export async function createTransferCode(): Promise<CloudResult<string>> {
  try {
    const { sb } = await client();
    const { data, error } = await sb.rpc('pf_create_transfer');
    if (error) throw error;
    return { ok: true, data: String(data) };
  } catch (e) { return fail(e); }
}

/** Redeem a code made on another browser. Returns how many flows moved over. */
export async function claimTransferCode(code: string): Promise<CloudResult<number>> {
  try {
    const { sb } = await client();
    const { data, error } = await sb.rpc('pf_claim_transfer', { code: code.trim().toUpperCase() });
    if (error) throw error;
    return { ok: true, data: Number(data) || 0 };
  } catch (e) { return fail(e); }
}

// ── CardMirror API token ──────────────────────────────────────────────────────

/** Mint a new token (revokes any existing one). Returns the raw token shown once. */
export async function createApiToken(): Promise<CloudResult<string>> {
  try {
    const { sb } = await client();
    const { data, error } = await sb.rpc('pf_create_api_token', { token_label: 'CardMirror' });
    if (error) throw error;
    return { ok: true, data: String(data) };
  } catch (e) { return fail(e); }
}

/** Revoke all tokens for this user. */
export async function revokeApiToken(): Promise<CloudResult<null>> {
  try {
    const { sb } = await client();
    const { error } = await sb.rpc('pf_revoke_api_token');
    if (error) throw error;
    return { ok: true, data: null };
  } catch (e) { return fail(e); }
}

/** True if this user has a token on file (does not expose the hash). */
export async function hasApiToken(): Promise<CloudResult<boolean>> {
  try {
    const { sb } = await client();
    const { count, error } = await sb
      .from('pf_api_tokens')
      .select('id', { count: 'exact', head: true });
    if (error) throw error;
    return { ok: true, data: (count ?? 0) > 0 };
  } catch (e) { return fail(e); }
}

/** Push the current focus state so CardMirror can target the right cell. */
export async function updatePresence(state: {
  flowId: string; flowName: string;
  sheetId: string; sheetName: string;
  focusedRow: number; focusedCol: number;
}): Promise<void> {
  try {
    const { sb, userId } = await client();
    await sb.from('pf_flow_presence').upsert({
      user_id: userId,
      flow_id: state.flowId,
      flow_name: state.flowName,
      sheet_id: state.sheetId,
      sheet_name: state.sheetName,
      focused_row: state.focusedRow,
      focused_col: state.focusedCol,
      // Real focus always clears any earlier pause — resuming via the chip
      // is "start acting normal again," not "start acting normal, but only
      // once something else also flips paused back off."
      paused: false,
    }, { onConflict: 'user_id' });
  } catch { /* presence is best-effort; never block the UI */ }
}

/** Clear presence when the flow tab closes. */
export async function clearPresence(): Promise<void> {
  try {
    const { sb, userId } = await client();
    await sb.from('pf_flow_presence').delete().eq('user_id', userId);
  } catch { /* best-effort */ }
}

/**
 * Mark this browser as paused without deleting its presence row — the tab is
 * still open, it just shouldn't be targeted. Distinct from clearPresence
 * (tab closed) so CardMirror can tell "not open" apart from "open, paused."
 */
export async function setPresencePaused(paused: boolean): Promise<void> {
  try {
    const { sb, userId } = await client();
    await sb.from('pf_flow_presence').upsert({ user_id: userId, paused }, { onConflict: 'user_id' });
  } catch { /* best-effort */ }
}
