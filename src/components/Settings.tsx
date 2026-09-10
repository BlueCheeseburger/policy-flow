import React, { useEffect, useState } from 'react';
import { useApp } from '../store/appStore';
import { listLmStudioModels, promptNames, promptSource } from '../platform/ai';
import { aiConfigured } from '../platform/settings';
import { readFlowPrefs, writeFlowPrefs, FLOW_PREFS_CHANGED_EVENT } from '../lib/flowPrefs';
import { createTransferCode, claimTransferCode } from '../platform/cloud';
import { clearAll } from '../platform/storage';
import Tooltip from './Tooltip';
import {
  DEFAULT_BINDINGS, getEffectiveBinding, hasCustomBinding, setCustomBinding, resetBinding,
  findConflict, formatBinding, bindingFromEvent, isBindingValid, isShortcutDisabled,
  toggleShortcutDisabled, type KeyBinding,
} from '../lib/shortcutPrefs';

export default function Settings({ onClose }: { onClose: () => void }) {
  const { settings, updateSettings, setFlowsIndex } = useApp();
  const [lmModels, setLmModels] = useState<string[]>([]);
  const [lmError, setLmError] = useState('');
  const [lmBusy, setLmBusy] = useState(false);

  const [transferCode, setTransferCode] = useState('');
  const [claimInput, setClaimInput] = useState('');
  const [transferMsg, setTransferMsg] = useState('');
  const [showPrompt, setShowPrompt] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  // Flow defaults live in their own store (lib/flowPrefs) because FlowView and
  // Home read them directly. Nothing in this app wrote them until now, which
  // left every one of them frozen at its default — including the one below that
  // silently spends an API call on hover.
  const [flowPrefs, setFlowPrefs] = useState(readFlowPrefs);
  function updateFlowPrefs(patch: Partial<ReturnType<typeof readFlowPrefs>>) {
    const next = { ...flowPrefs, ...patch };
    setFlowPrefs(next);
    writeFlowPrefs(next);
    window.dispatchEvent(new CustomEvent(FLOW_PREFS_CHANGED_EVENT, { detail: next }));
  }

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
    <div className="flex-1 overflow-auto">
      <div className="mx-auto px-8 py-9 flex flex-col gap-4" style={{ maxWidth: 720 }}>
        <header className="flex items-center justify-between mb-1">
          <h1 className="text-[25px] font-semibold tracking-[-0.018em]">Settings</h1>
          <button className="btn h-8 px-3.5" onClick={onClose}>Done</button>
        </header>

        {/* Each section is its own card. Before, five unrelated groups ran
            together as one long column of label/control rows, so "Clear local
            data" sat in the same visual container as the theme picker. */}
        <Section title="Appearance">
          <Row label="Theme">
            <Segmented
              value={settings.theme}
              onChange={(v) => updateSettings({ theme: v as any })}
              options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
            />
          </Row>
          <Row label="New flow layout" hint="Which tabs a new flow starts with.">
            <Segmented
              value={flowPrefs.defaultVariant}
              onChange={(v) => updateFlowPrefs({ defaultVariant: v as any })}
              options={[{ value: 'stock-issues', label: 'Stock Issues' }, { value: 'advantage', label: 'Advantage' }]}
            />
          </Row>
          <Row label="Side colors" hint="Used for the aff and neg speech columns on every flow.">
            <div className="flex items-center gap-2">
              <Swatch label="Aff" value={settings.affColor} onChange={(v) => updateSettings({ affColor: v })} />
              <Swatch label="Neg" value={settings.negColor} onChange={(v) => updateSettings({ negColor: v })} />
            </div>
          </Row>
        </Section>

        <Section title="Cell density and type" intro="How much of a round fits on one screen. Applies to every flow, live.">
          <Row label="Text size" hint={`${flowPrefs.defaultFontSize}px`}>
            <input
              type="range" min={10} max={20} step={1}
              className="flex-1 max-w-[220px]"
              style={{ accentColor: 'var(--accent)' }}
              value={flowPrefs.defaultFontSize}
              onChange={(e) => updateFlowPrefs({ defaultFontSize: Number(e.target.value) })}
            />
          </Row>
          <Row label="Row height" hint={`${flowPrefs.rowHeight}px minimum`}>
            <input
              type="range" min={22} max={64} step={2}
              className="flex-1 max-w-[220px]"
              style={{ accentColor: 'var(--accent)' }}
              value={flowPrefs.rowHeight}
              onChange={(e) => updateFlowPrefs({ rowHeight: Number(e.target.value) })}
            />
          </Row>
          <Row label="Typeface">
            <Segmented
              value={flowPrefs.cellFont}
              onChange={(v) => updateFlowPrefs({ cellFont: v as any })}
              options={[{ value: 'sans', label: 'Sans' }, { value: 'mono', label: 'Mono' }]}
            />
          </Row>
          <div
            className="rounded-[9px] px-3 py-2.5 mt-1"
            style={{ background: 'var(--bg-nest)' }}
          >
            <div
              className="truncate"
              style={{
                fontSize: flowPrefs.defaultFontSize,
                minHeight: flowPrefs.rowHeight,
                display: 'flex',
                alignItems: 'center',
                fontFamily: flowPrefs.cellFont === 'mono' ? 'var(--font-mono)' : 'var(--font-text)',
              }}
            >
              Warming causes extinction — Mann 24
            </div>
          </div>
        </Section>

        <Section title="Keyboard shortcuts" intro="Rebind or switch off any of these. Core keys — Enter, Tab, arrows — stay fixed.">
          <Shortcuts />
        </Section>

        <Section
          title="Moving to another browser"
          intro="There are no accounts here, so your flows belong to this browser. Clearing site data or switching machines loses them unless you move them first — a transfer code hands every flow you own to another browser."
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn h-8 px-3"
              onClick={async () => {
                const res = await createTransferCode();
                if (res.ok) { setTransferCode(res.data); setTransferMsg(''); }
                else setTransferMsg(res.error);
              }}
            >
              Make a transfer code
            </button>
            {transferCode && (
              <>
                <code
                  className="px-3 h-8 inline-flex items-center rounded-[9px] font-mono text-sm tracking-[0.16em]"
                  style={{ background: 'var(--bg-nest)', border: '1px solid var(--border-med)' }}
                >
                  {transferCode}
                </code>
                <span className="text-xs" style={{ color: 'var(--label-color)' }}>
                  Valid 30 minutes, usable once
                </span>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono text-sm tracking-[0.16em]"
              placeholder="Paste a code from your other browser"
              value={claimInput}
              spellCheck={false}
              onChange={(e) => setClaimInput(e.target.value)}
            />
            <button
              className="btn px-3 shrink-0"
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
        </Section>

        <Section
          title="AI"
          intro={aiConfigured(settings)
            ? `${settings.provider === 'gemini' ? 'Gemini' : 'LM Studio'} · connected`
            : 'No key set — Auto Flow still reads docs'}
        >

          <Row label="Provider">
            <Segmented
              value={settings.provider}
              onChange={(v) => updateSettings({ provider: v as any })}
              options={[{ value: 'gemini', label: 'Gemini' }, { value: 'lmstudio', label: 'LM Studio' }]}
            />
          </Row>

          {settings.provider === 'gemini' ? (
            <>
              <Row label="API key">
                <div className="flex-1 flex gap-2">
                  <input
                    className="input flex-1 font-mono text-xs"
                    type={showKey ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="AIza…"
                    value={settings.geminiKey}
                    onChange={(e) => updateSettings({ geminiKey: e.target.value })}
                  />
                  <button className="btn px-2.5 shrink-0" onClick={() => setShowKey((v) => !v)}>
                    {showKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              </Row>
              <div className="callout">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 mt-px" aria-hidden="true">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <span>
                  Stored in this browser, unencrypted — anyone who can open devtools on this
                  machine can read it. Think twice on a shared or school laptop. It is never
                  included in an export, and only ever sent to Google.
                </span>
              </div>
              <Row label="Model">
                <input
                  className="input flex-1 font-mono text-xs"
                  value={settings.geminiModel}
                  spellCheck={false}
                  onChange={(e) => updateSettings({ geminiModel: e.target.value })}
                />
              </Row>
            </>
          ) : (
            <>
              <Row label="Server address">
                <div className="flex-1 flex gap-2">
                  <input
                    className="input flex-1 font-mono text-xs"
                    value={settings.lmStudioUrl}
                    spellCheck={false}
                    onChange={(e) => updateSettings({ lmStudioUrl: e.target.value })}
                  />
                  <button className="btn px-2.5 shrink-0" onClick={testLmStudio} disabled={lmBusy}>
                    {lmBusy ? 'Checking…' : 'Test'}
                  </button>
                </div>
              </Row>
              {lmModels.length > 0 && (
                <Row label="Model">
                  <select
                    className="input flex-1"
                    value={settings.lmStudioModel}
                    onChange={(e) => updateSettings({ lmStudioModel: e.target.value })}
                  >
                    <option value="">Pick a model…</option>
                    {lmModels.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </Row>
              )}
              {lmError && <p className="text-xs" style={{ color: 'var(--danger)' }} role="alert">{lmError}</p>}
              <p className="text-xs leading-relaxed" style={{ color: 'var(--label-color)' }}>
                LM Studio runs on your own machine, so nothing leaves it. Two catches: turn on
                <strong className="font-semibold"> CORS </strong>
                in LM Studio's server settings, and use Chrome, Edge or Firefox — Safari blocks a
                page like this one from reaching <code className="font-mono">localhost</code> at all.
              </p>
            </>
          )}

          <Row label="Auto Flow instructions" hint={`${settings.autoFlowInstructions.length}/300 characters`}>
            <textarea
              className="input flex-1 text-xs"
              rows={3}
              maxLength={300}
              placeholder="e.g. put topicality on its own tab"
              value={settings.autoFlowInstructions}
              onChange={(e) => updateSettings({ autoFlowInstructions: e.target.value })}
            />
          </Row>

          <div className="divider pt-3.5">
            <label className="flex items-start gap-2.5 text-sm cursor-pointer mb-3">
              <input
                type="checkbox"
                className="mt-0.5"
                style={{ accentColor: 'var(--accent)' }}
                checked={flowPrefs.aiTabSummaries}
                onChange={(e) => updateFlowPrefs({ aiTabSummaries: e.target.checked })}
              />
              <span className="flex-1">
                <span className="font-medium">Summarise a tab when I hover it</span>
                <span className="block text-xs mt-0.5" style={{ color: 'var(--label-color)' }}>
                  Costs an API call per tab, the first time its contents change. Off, the tooltip
                  still shows a free preview built from the tags already on the flow.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2.5 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 accent-current"
                style={{ accentColor: 'var(--accent)' }}
                checked={settings.longInputAllowed}
                onChange={(e) => updateSettings({ longInputAllowed: e.target.checked })}
              />
              <span className="flex-1">
                <span className="font-medium">Let Analyze Round work past the one-call length limit</span>
                <span className="block text-xs mt-0.5" style={{ color: 'var(--label-color)' }}>
                  Off, a long flow is cut down and you are told what was dropped.
                </span>
              </span>
            </label>
            {settings.longInputAllowed && (
              <div className="mt-2.5 ml-6">
                <Segmented
                  value={settings.longInputMethod}
                  onChange={(v) => updateSettings({ longInputMethod: v as any })}
                  options={[{ value: 'sample', label: 'Sample every sheet' }, { value: 'passes', label: 'Read in passes' }]}
                />
              </div>
            )}
          </div>

          <div className="divider pt-4 flex flex-col gap-2">
            <h3 className="label">Prompts</h3>
            <p className="text-sm">Exactly what gets sent to the model, for every AI feature here.</p>

          <div className="flex flex-col">
            {promptNames().map((n, i) => (
              <div key={n} className={i > 0 ? 'divider' : ''}>
                <button
                  className="btn-icon w-full flex items-center justify-between gap-3 py-2.5 text-left"
                  onClick={() => setShowPrompt(showPrompt === n ? null : n)}
                >
                  <span className="font-mono text-xs">{n}</span>
                  <span className="text-xs shrink-0" style={{ color: 'var(--label-color)' }}>
                    {showPrompt === n ? 'Hide' : 'View'}
                  </span>
                </button>
                {showPrompt === n && (
                  <pre
                    className="text-[11px] leading-relaxed p-3 mb-2.5 rounded-[9px] overflow-auto max-h-72 whitespace-pre-wrap font-mono"
                    style={{ background: 'var(--bg-nest)' }}
                  >
                    {promptSource(n)}
                  </pre>
                )}
              </div>
            ))}
          </div>
          </div>
        </Section>

        <Section title="Clear local data" danger>
          <p className="text-sm leading-relaxed">
            Erases every flow stored in this browser. Flows already synced stay on the server and
            come back on reload; anything that never synced is gone.
          </p>
          <Tooltip text="Erase local flows">
            <button
              className="btn h-8 px-3 self-start"
              style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 35%, transparent)' }}
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
        </Section>
      </div>
    </div>
  );
}

/** Which shortcuts this app actually wires up. DEFAULT_BINDINGS still carries a
 *  few ids from the app this was ported from (global search, the shortcuts
 *  overlay, doc comments) that nothing here listens for — listing those would
 *  offer to rebind a key that does nothing. */
const SHORTCUT_ROWS: { id: string; label: string }[] = [
  { id: 'flow-bold', label: 'Bold' },
  { id: 'flow-italic', label: 'Italic' },
  { id: 'flow-underline', label: 'Underline' },
  { id: 'flow-strike', label: 'Strikethrough' },
  { id: 'flow-highlight', label: 'Highlight' },
  { id: 'flow-undo', label: 'Undo' },
  { id: 'flow-redo', label: 'Redo' },
  { id: 'flow-link', label: 'Draw an arrow' },
  { id: 'flow-sheet-new', label: 'New tab' },
  { id: 'find-page', label: 'Find' },
];

const MOD_GLYPH = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

function Shortcuts() {
  const [, bump] = useState(0);
  const [recording, setRecording] = useState<string | null>(null);
  // A rebind that collides with another shortcut is not silently dropped and not
  // silently applied: it is held here until the user says which one should win.
  const [conflict, setConflict] = useState<{ id: string; binding: KeyBinding; withId: string } | null>(null);
  const refresh = () => bump((n) => n + 1);

  useEffect(() => {
    if (!recording) return;
    const id = recording;   // narrowed: the effect only runs when it is set
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setRecording(null); return; }
      // Ignore a bare modifier press — wait for the actual key.
      if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
      const binding = bindingFromEvent(e);
      if (!isBindingValid(binding)) return;   // needs ⌘ or ⌥ to be a shortcut
      const clash = findConflict(id, binding);
      if (clash) { setConflict({ id, binding, withId: clash }); setRecording(null); return; }
      setCustomBinding(id, binding);
      setRecording(null);
      refresh();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  const labelFor = (id: string) => SHORTCUT_ROWS.find((r) => r.id === id)?.label ?? id;

  return (
    <div className="flex flex-col">
      {SHORTCUT_ROWS.map((row, i) => {
        const off = isShortcutDisabled(row.id);
        const binding = getEffectiveBinding(row.id);
        const custom = hasCustomBinding(row.id);
        return (
          <div key={row.id} className={`flex items-center gap-3 py-2 ${i > 0 ? 'divider' : ''}`}>
            <span className="flex-1 text-sm" style={{ opacity: off ? 0.45 : 1 }}>{row.label}</span>
            {custom && !off && (
              <button className="btn-icon text-[11px]" style={{ color: 'var(--label-color)' }}
                onClick={() => { resetBinding(row.id); refresh(); }}>
                Reset
              </button>
            )}
            <button
              className="btn px-2.5 h-7 font-mono text-[11px] min-w-[74px]"
              disabled={off}
              onClick={() => setRecording(recording === row.id ? null : row.id)}
              style={recording === row.id ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
            >
              {recording === row.id ? 'Press keys…' : binding ? formatBinding(binding, MOD_GLYPH) : '—'}
            </button>
            <Tooltip text={off ? 'Turn this shortcut on' : 'Turn this shortcut off'}>
              <input
                type="checkbox"
                style={{ accentColor: 'var(--accent)' }}
                checked={!off}
                onChange={() => { toggleShortcutDisabled(row.id); refresh(); }}
              />
            </Tooltip>
          </div>
        );
      })}

      {conflict && (
        <div className="callout mt-3" style={{ display: 'block' }} role="alert">
          <strong>{formatBinding(conflict.binding, MOD_GLYPH)}</strong> is already{' '}
          <strong>{labelFor(conflict.withId)}</strong>. Two shortcuts can't share a combo — pick which one keeps it.
          <div className="flex gap-2 mt-2">
            <button
              className="btn px-2.5 h-7"
              onClick={() => {
                // Free the combo from its current owner, then take it.
                resetBinding(conflict.withId);
                toggleShortcutDisabled(conflict.withId);
                setCustomBinding(conflict.id, conflict.binding);
                setConflict(null);
                refresh();
              }}
            >
              Give it to {labelFor(conflict.id)}
            </button>
            <button className="btn px-2.5 h-7" onClick={() => { setConflict(null); setRecording(conflict.id); }}>
              Pick a different key
            </button>
            <button className="btn px-2.5 h-7" onClick={() => setConflict(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, intro, danger, children }: {
  title: string;
  intro?: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-[13px] border p-5 flex flex-col gap-3.5"
      style={{
        background: 'var(--bg-card)',
        borderColor: danger ? 'color-mix(in srgb, var(--danger) 28%, transparent)' : 'var(--border-subtle)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <h2 className="label" style={danger ? { color: 'var(--danger)' } : undefined}>{title}</h2>
      {intro && <p className="text-sm leading-relaxed -mt-1">{intro}</p>}
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-4 text-sm">
      <span className="w-36 shrink-0 pt-1.5">
        <span className="block" style={{ color: 'var(--ink-muted)' }}>{label}</span>
        {hint && <span className="block text-xs mt-0.5" style={{ color: 'var(--label-color)' }}>{hint}</span>}
      </span>
      {children}
    </label>
  );
}

/** A pill of mutually exclusive choices — clearer at a glance than a select. */
function Segmented({ value, onChange, options }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-[9px] p-0.5 gap-0.5" style={{ background: 'var(--mode-toggle-bg)' }} role="radiogroup">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            className="px-2.5 py-1 rounded-[7px] text-xs font-medium transition-colors"
            style={active
              ? { background: 'var(--nav-active-bg)', color: 'var(--nav-active-color)', boxShadow: 'var(--nav-active-shadow)' }
              : { color: 'var(--ink-muted)' }}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A color well. The native `<input type="color">` paints its own chrome — a
 * white bevelled box that looks broken on a dark ground — so it is sized to the
 * swatch and made invisible, leaving the styled surface underneath as the
 * control. The real input still handles the click, so the OS picker and
 * keyboard focus behave normally.
 */
function Swatch({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <span
      className="relative inline-flex items-center gap-2 h-8 pl-1.5 pr-2.5 rounded-[9px] cursor-pointer"
      style={{ background: 'var(--bg-nest)', border: '1px solid var(--border-med)' }}
    >
      <span className="w-5 h-5 rounded-md shrink-0" style={{ background: value, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.18)' }} />
      <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>{label}</span>
      <span className="font-mono text-[10.5px] uppercase" style={{ color: 'var(--label-color)' }}>{value}</span>
      <input
        type="color"
        aria-label={`${label} color`}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </span>
  );
}
