// The plugin's own settings window: pairing code, the headings toggle, and
// the README's "What it does" / "Setting it up" as expandable sections.
//
// CardMirror renders a gear for a plugin's declared settings, but only on
// rows in its installed list, so a plugin added with "Load plugin from
// file…" (the only route before the fork's allowlist ships) has no gear
// and no way to enter a code. This window works however the plugin was
// loaded. It's plain DOM because a plugin is ordinary renderer code.

import { helpSections } from './readmeSections';

export interface SettingsWindowOpts {
  code: string;
  includeHeadings: boolean;
  onSave(next: { code: string; includeHeadings: boolean }): void;
}

const STYLE_ID = 'pf-plugin-settings-style';
const CSS = `
.pfp-backdrop { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
  background: rgba(10, 12, 20, .45); font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.pfp-card { --bg: #ffffff; --ink: #1b1d26; --muted: #626779; --line: #dfe1ea; --field: #f4f5f9; --accent: #5b5bd6;
  width: min(520px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow: auto; background: var(--bg); color: var(--ink);
  border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 18px 60px rgba(0,0,0,.28); padding: 18px 20px 16px; }
@media (prefers-color-scheme: dark) { .pfp-card { --bg: #1f2029; --ink: #e8e9f0; --muted: #9a9eb0; --line: #34364a; --field: #282a36; --accent: #8f8cff; } }
.pfp-card h2 { margin: 0 0 2px; font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
.pfp-sub { margin: 0 0 14px; color: var(--muted); font-size: 12px; }
.pfp-label { display: block; font-weight: 600; margin: 0 0 5px; }
.pfp-input { width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--field); color: var(--ink); font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; }
.pfp-input:focus-visible, .pfp-card button:focus-visible, .pfp-card summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.pfp-hint { margin: 5px 0 12px; color: var(--muted); font-size: 12px; }
.pfp-check { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 14px; cursor: pointer; }
.pfp-check input { margin-top: 3px; }
.pfp-card details { border-top: 1px solid var(--line); padding: 8px 0; }
.pfp-card details:last-of-type { border-bottom: 1px solid var(--line); }
.pfp-card summary { cursor: pointer; font-weight: 600; list-style-position: inside; }
.pfp-card details ul, .pfp-card details ol { margin: 8px 0 4px; padding-left: 20px; }
.pfp-card details ul { list-style: disc outside; }
.pfp-card details ol { list-style: decimal outside; }
.pfp-card details li { margin: 0 0 6px; }
.pfp-card details p { margin: 8px 0 4px; }
.pfp-card code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--field); padding: 1px 4px; border-radius: 4px; }
.pfp-card a { color: var(--accent); }
.pfp-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.pfp-card button { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--field); color: var(--ink);
  font: 600 13px system-ui, -apple-system, sans-serif; cursor: pointer; }
.pfp-card button.pfp-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.pfp-card button:disabled { opacity: .45; cursor: default; }
`;

let open: HTMLElement | null = null;

export function openSettingsWindow(opts: SettingsWindowOpts): void {
  if (open) { open.querySelector<HTMLInputElement>('.pfp-input')?.focus(); return; }
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'pfp-backdrop';
  const card = document.createElement('div');
  card.className = 'pfp-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'pfp-title');
  card.innerHTML = `
    <h2 id="pfp-title">Policy Flow</h2>
    <p class="pfp-sub">Send cards to your open flow, and jump back from it.</p>
    <label class="pfp-label" for="pfp-code">Pairing code</label>
    <input class="pfp-input" id="pfp-code" type="text" autocomplete="off" spellcheck="false" placeholder="Paste the code from Policy Flow">
    <p class="pfp-hint">Get one in Policy Flow → Settings → CardMirror → Generate pairing code.</p>
    <label class="pfp-check"><input type="checkbox" id="pfp-heads"><span>Send pocket, hat, and block titles as rows<br>
      <span class="pfp-hint" style="margin:0">When sending a whole section, its titles go in underlined between the cards.</span></span></label>
    <div class="pfp-help"></div>
    <div class="pfp-actions"><button type="button" class="pfp-cancel">Cancel</button><button type="button" class="pfp-primary pfp-save">Save</button></div>`;

  // The README sections, collapsed by default. Built from our own escaped
  // markup (readmeSections.ts), not from anything a document supplied.
  const help = card.querySelector('.pfp-help')!;
  for (const s of helpSections()) {
    const d = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = s.title;
    const body = document.createElement('div');
    body.innerHTML = s.html;
    d.append(sum, body);
    help.append(d);
  }

  const code = card.querySelector<HTMLInputElement>('#pfp-code')!;
  const heads = card.querySelector<HTMLInputElement>('#pfp-heads')!;
  const save = card.querySelector<HTMLButtonElement>('.pfp-save')!;
  code.value = opts.code;
  heads.checked = opts.includeHeadings;

  // Save stays off until something actually changed.
  const dirty = () => code.value.trim() !== opts.code || heads.checked !== opts.includeHeadings;
  const sync = () => { save.disabled = !dirty(); };
  code.addEventListener('input', sync);
  heads.addEventListener('change', sync);
  sync();

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    open = null;
  };
  const commit = () => {
    if (!dirty()) return;
    opts.onSave({ code: code.value.trim(), includeHeadings: heads.checked });
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    // Captured so the editor's own shortcuts (including ~) don't fire underneath.
    if (!backdrop.isConnected) return;
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && e.target === code) { e.preventDefault(); commit(); }
  };
  document.addEventListener('keydown', onKey, true);
  card.querySelector('.pfp-cancel')!.addEventListener('click', close);
  save.addEventListener('click', commit);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });

  backdrop.append(card);
  document.body.append(backdrop);
  open = backdrop;
  code.focus();
}
