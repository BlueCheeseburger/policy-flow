// The Supabase client, and the hidden browser identity everything hangs off.
//
// There are no accounts here. On first load the app signs in anonymously, which
// mints a durable, nameless auth user for this browser. That uid is what owns a
// flow, what a share grant is issued to, and what a transfer code moves. The
// user never sees it and never types anything to get one.
//
// The consequence is worth stating plainly, and the UI does: losing the browser
// loses the identity. Clearing site data, a fresh profile, or a different
// machine is a different person as far as the server is concerned. A transfer
// code is the only bridge, and only if it was made beforehand.

import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** False when the build has no Supabase config — the app still flows locally. */
export const cloudConfigured = !!(URL && KEY);

export const supabase: SupabaseClient | null = cloudConfigured
  ? createClient(URL!, KEY!, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'policyflow-auth' },
      realtime: { params: { eventsPerSecond: 40 } },
    })
  : null;

let identityPromise: Promise<User | null> | null = null;

/**
 * The current browser identity, signing in anonymously if there isn't one yet.
 * Resolves to null when the cloud isn't configured or sign-in fails — every
 * caller must keep working locally in that case rather than blocking the app.
 */
export function getIdentity(): Promise<User | null> {
  if (identityPromise) return identityPromise;
  identityPromise = (async () => {
    if (!supabase) return null;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) return session.user;
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      return data.user ?? null;
    } catch {
      // Offline, anonymous sign-ins turned off, or a blocked request. Flowing
      // is local-first, so this is a degraded mode, not a dead app.
      return null;
    }
  })();
  return identityPromise;
}

/** Forget the cached identity so the next call re-reads the session. */
export function resetIdentity(): void { identityPromise = null; }

/**
 * A stable display color for a peer, derived from their uid. Presence is colors
 * only — no names are collected anywhere, so this is the entire identity a
 * co-editor ever sees of another.
 */
export function colorForUser(id: string): string {
  const COLORS = ['#0077ed', '#e0405e', '#16a34a', '#a855f7', '#f59e0b', '#06b6d4', '#ec4899', '#84cc16'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}
