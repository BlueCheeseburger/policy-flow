import React, { useState } from 'react';
import { useApp } from '../store/appStore';
import { listLmStudioModels, promptNames, promptSource } from '../platform/ai';
import { createTransferCode, claimTransferCode } from '../platform/cloud';
import { clearAll } from '../platform/storage';
import Tooltip from './Tooltip';

export default function Settings({ onClose }: { onClose: () => void }) {
  const { settings, updateSettings, setFlowsIndex } = useApp();
  const [lmModels, setLmModels] = useState<string[]>([]);
  const [lmError, setLmError] = useState('');
  const [lmBusy, setLmBusy] = useState(false);

  const [transferCode, setTransferCode] = useState('');
  const [claimInput, setClaimInput] = useState('');
  const [transferMsg, setTransferMsg] = useState('');
  const [showPrompt, setShowPrompt] = useState<string | null>(null);

  async function testLmStudio() {
    setLmBusy(true); setLmError(''); setLmModels([]);
    try {
      const models = await listLmStudioModels(settings.lmStudioUrl);
      setLmModels(models);
      if (models.length === 0) setLmError('Connected, but no model is loaded in LM Studio.');
    } catch (e: any) {
      setLmError(e?.message || 'Could not reach LM Studio.');
    } finally {
      setLmBusy(false);
    }
  }

  return (
    <div className="flex-1 overflow-auto p-8">
      <div className="max-w-2xl mx-auto flex flex-col gap-8">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Settings</h1>
          <button className="btn px-3 py-1.5" onClick={onClose}>Done</button>
        </header>

        {/* ── Appearance ──────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--label-color)' }}>
            Appearance
          </h2>
          <Row label="Theme">
            <select
              className="input"
              value={settings.theme}
              onChange={(e) => updateSettings({ theme: e.target.value as any })}
            >
              <option value="system">Match my system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </Row>
          <Row label="Aff color">
            <input type="color" className="h-8 w-14 rounded border" value={settings.affColor}
              onChange={(e) => updateSettings({ affColor: e.target.value })} />
          </Row>
          <Row label="Neg color">
            <input type="color" className="h-8 w-14 rounded border" value={settings.negColor}
              onChange={(e) => updateSettings({ negColor: e.target.value })} />
          </Row>
        </section>

        {/* ── AI ──────────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--label-color)' }}>
            AI
          </h2>
          <p className="text-sm leading-relaxed">
            Auto Flow reads your speech docs without any AI at all. A key adds the
            parts that need a model: sorting cards into tabs, card summaries, tab
            summaries on hover, and Analyze Round.
          </p>

          <Row label="Provider">
            <select className="input" value={settings.provider}
              onChange={(e) => updateSettings({ provider: e.target.value as any })}>
              <option value="gemini">Gemini</option>
              <option value="lmstudio">LM Studio (on this machine)</option>
            </select>
          </Row>

          {settings.provider === 'gemini' ? (
            <>
              <Row label="API key">
                <input
                  className="input flex-1 font-mono text-xs"
                  type="password"
                  autoComplete="off"
                  placeholder="AIza…"
                  value={settings.geminiKey}
                  onChange={(e) => updateSettings({ geminiKey: e.target.value })}
                />
              </Row>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--warn)' }}>
                This key is stored in this browser, unencrypted. Anyone who can open
                devtools on this machine can read it — think twice on a shared or
                school laptop. It is never included in an export, and it is only ever
                sent to Google.
              </p>
              <Row label="Model">
                <input className="input flex-1 font-mono text-xs" value={settings.geminiModel}
                  onChange={(e) => updateSettings({ geminiModel: e.target.value })} />
              </Row>
            </>
          ) : (
            <>
              <Row label="Server address">
                <input className="input flex-1 font-mono text-xs" value={settings.lmStudioUrl}
                  onChange={(e) => updateSettings({ lmStudioUrl: e.target.value })} />
              </Row>
              <div className="flex items-center gap-2">
                <button className="btn px-3 py-1.5" onClick={testLmStudio} disabled={lmBusy}>
                  {lmBusy ? 'Checking…' : 'Test connection'}
                </button>
                {lmModels.length > 0 && (
                  <select className="input flex-1" value={settings.lmStudioModel}
                    onChange={(e) => updateSettings({ lmStudioModel: e.target.value })}>
                    <option value="">Pick a model…</option>
                    {lmModels.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                )}
              </div>
              {lmError && <p className="text-xs" style={{ color: 'var(--danger)' }}>{lmError}</p>}
              <p className="text-xs leading-relaxed" style={{ color: 'var(--label-color)' }}>
                LM Studio runs on your own machine, so nothing leaves it. Two catches:
                turn on <strong>CORS</strong> in LM Studio's server settings, and use
                Chrome, Edge or Firefox — Safari blocks a page like this one from
                reaching <code>localhost</code> at all.
              </p>
            </>
          )}

          <Row label="Auto Flow instructions">
            <textarea
              className="input flex-1 text-xs"
              rows={3}
              maxLength={300}
              placeholder="e.g. put topicality on its own tab"
              value={settings.autoFlowInstructions}
              onChange={(e) => updateSettings({ autoFlowInstructions: e.target.value })}
            />
          </Row>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={settings.longInputAllowed}
              onChange={(e) => updateSettings({ longInputAllowed: e.target.checked })}
            />
            <span>
              Let Analyze Round work past the model's one-call length limit.
              {settings.longInputAllowed && (
                <select
                  className="input ml-2 text-xs"
                  value={settings.longInputMethod}
                  onChange={(e) => updateSettings({ longInputMethod: e.target.value as any })}
                >
                  <option value="sample">Sample every sheet evenly (one call)</option>
                  <option value="passes">Read the whole flow in passes (slower, complete)</option>
                </select>
              )}
            </span>
          </label>
        </section>

        {/* ── Prompts ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--label-color)' }}>
            Prompts
          </h2>
          <p className="text-sm">Exactly what gets sent to the model, for every AI feature here.</p>
          <div className="flex flex-wrap gap-2">
            {promptNames().map((n) => (
              <button key={n} className="btn px-2 py-1 text-xs font-mono"
                onClick={() => setShowPrompt(showPrompt === n ? null : n)}>
                {n}
              </button>
            ))}
          </div>
          {showPrompt && (
            <pre
              className="text-xs p-3 rounded-lg border overflow-auto max-h-72 whitespace-pre-wrap"
              style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}
            >
              {promptSource(showPrompt)}
            </pre>
          )}
        </section>

        {/* ── This browser ────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--label-color)' }}>
            Moving to another browser
          </h2>
          <p className="text-sm leading-relaxed">
            There are no accounts here, so your flows belong to <em>this browser</em>.
            Clearing site data or switching machines loses them unless you move them
            first. A transfer code hands every flow you own to another browser — make
            it here, then redeem it there.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn px-3 py-1.5"
              onClick={async () => {
                const res = await createTransferCode();
                if (res.ok) { setTransferCode(res.data); setTransferMsg(''); }
                else setTransferMsg(res.error);
              }}
            >
              Make a transfer code
            </button>
            {transferCode && (
              <code className="px-3 py-1.5 rounded-lg border font-mono text-sm tracking-widest"
                style={{ borderColor: 'var(--border-color)' }}>
                {transferCode}
              </code>
            )}
          </div>
          {transferCode && (
            <p className="text-xs" style={{ color: 'var(--label-color)' }}>
              Valid for 30 minutes, and usable once.
            </p>
          )}
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono text-sm tracking-widest"
              placeholder="Paste a code from your other browser"
              value={claimInput}
              onChange={(e) => setClaimInput(e.target.value)}
            />
            <button
              className="btn px-3"
              disabled={!claimInput.trim()}
              onClick={async () => {
                const res = await claimTransferCode(claimInput);
                if (!res.ok) { setTransferMsg(res.error); return; }
                setTransferMsg(`${res.data} flow${res.data === 1 ? '' : 's'} moved here. Reload to see them.`);
                setClaimInput('');
              }}
            >
              Redeem
            </button>
          </div>
          {transferMsg && <p className="text-sm">{transferMsg}</p>}
        </section>

        {/* ── Danger ──────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2 pb-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--danger)' }}>
            Clear local data
          </h2>
          <p className="text-sm">
            Erases every flow stored in this browser. Flows already synced stay on the
            server and come back on reload; anything that never synced is gone.
          </p>
          <Tooltip text="Erase local flows">
            <button
              className="btn px-3 py-1.5 self-start"
              style={{ color: 'var(--danger)' }}
              onClick={async () => {
                if (!window.confirm('Erase every flow stored in this browser?')) return;
                await clearAll();
                setFlowsIndex([]);
                window.location.reload();
              }}
            >
              Clear local data
            </button>
          </Tooltip>
        </section>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="w-40 shrink-0" style={{ color: 'var(--label-color)' }}>{label}</span>
      {children}
    </label>
  );
}
