import React, { useEffect, useState } from 'react';
import { useApp } from './store/appStore';
import FlowView from './components/FlowView';
import Home from './components/Home';
import Settings from './components/Settings';
import AutoFlow from './components/AutoFlow';
import UndoToasts from './components/UndoToasts';
import TruncationConfirm from './components/TruncationConfirm';
import Logo from './components/Logo';
import { readKey, writeKey, flushWrites } from './platform/storage';
import { getIdentity, cloudConfigured } from './platform/supabase';
import { joinFlow } from './platform/cloud';
import { readSettings, SETTINGS_CHANGED_EVENT } from './platform/settings';

/** Apply the theme to <html> — light/dark, or whatever the OS is set to. */
function useTheme() {
  useEffect(() => {
    const apply = () => {
      const t = readSettings().theme;
      const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    window.addEventListener(SETTINGS_CHANGED_EVENT, apply);
    return () => {
      mq.removeEventListener('change', apply);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, apply);
    };
  }, []);
}

export default function App() {
  const { view, setView, flowsIndex, setFlowsIndex, setIdentityId } = useApp();
  const [booted, setBooted] = useState(false);
  const [autoFlowOpen, setAutoFlowOpen] = useState(false);
  const [joinError, setJoinError] = useState('');

  useTheme();

  // Boot: read the local flow list, then resolve the browser identity. The list
  // comes first deliberately — flowing must not wait on the network, and a
  // failed sign-in leaves the app fully usable offline.
  useEffect(() => {
    (async () => {
      const idx = await readKey<any[]>('flows_index');
      if (Array.isArray(idx)) setFlowsIndex(idx.filter((f) => f && typeof f.id === 'string'));
      setBooted(true);
      if (cloudConfigured) {
        const user = await getIdentity();
        setIdentityId(user?.id ?? null);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A share link is `#/join/<token>`. The token rides in the URL FRAGMENT, not
  // the query string, so it is never sent to a server or written into a Referer
  // header on the way to some other page.
  useEffect(() => {
    if (!booted) return;
    const m = window.location.hash.match(/^#\/join\/([A-Za-z0-9_-]+)$/);
    if (!m) return;
    const token = m[1];
    // Clear it immediately so a reload (or a screenshot of the address bar)
    // doesn't keep re-joining, and so the token isn't left sitting in history.
    history.replaceState(null, '', window.location.pathname);
    (async () => {
      const res = await joinFlow(token);
      if (!res.ok) { setJoinError(res.error); return; }
      const existing = flowsIndex.find((f) => f.id === res.data.id);
      if (!existing) {
        const next = [...flowsIndex, {
          id: res.data.id, name: res.data.name, event: 'policy' as const,
          cloud: true, shared: true, live: true, createdAt: new Date().toISOString(),
        }];
        setFlowsIndex(next);
        await writeKey('flows_index', next);
      }
      setView({ kind: 'flow', flowId: res.data.id });
    })();
  }, [booted]); // eslint-disable-line react-hooks/exhaustive-deps

  // Don't lose the last few keystrokes to a tab close mid-write.
  useEffect(() => {
    const onHide = () => { void flushWrites(); };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  if (!booted) return <div className="min-h-screen" style={{ background: 'var(--bg-main)' }} />;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-main)' }}>
      <TopBar
        inFlow={view.kind === 'flow'}
        onHome={() => setView({ kind: 'home' })}
        onSettings={() => setView({ kind: 'settings' })}
      />

      {joinError && (
        <div className="px-4 py-2 text-sm flex items-center justify-between" style={{ background: 'color-mix(in srgb, var(--warn) 14%, var(--bg-main))' }} role="alert">
          <span>{joinError}</span>
          <button className="btn-icon px-2" onClick={() => setJoinError('')}>✕</button>
        </div>
      )}

      {view.kind === 'home' && <Home onAutoFlow={() => setAutoFlowOpen(true)} />}
      {view.kind === 'settings' && <Settings onClose={() => setView({ kind: 'home' })} />}
      {view.kind === 'flow' && <FlowView />}

      {autoFlowOpen && <AutoFlow onClose={() => setAutoFlowOpen(false)} />}
      <TruncationConfirm />
      <UndoToasts />
    </div>
  );
}

function TopBar({ inFlow, onHome, onSettings }: { inFlow: boolean; onHome: () => void; onSettings: () => void }) {
  return (
    <div
      className="h-11 shrink-0 flex items-center gap-3 px-4 border-b"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <button className="btn-icon flex items-center gap-2 font-semibold text-sm" onClick={onHome} title={inFlow ? 'Back to your flows' : 'Policy Flow'}>
        <Logo size={20} />
        <span>{inFlow ? '← Flows' : 'Policy Flow'}</span>
      </button>
      <div className="flex-1" />
      <button className="btn-icon text-sm" onClick={onSettings} title="Settings">Settings</button>
    </div>
  );
}
