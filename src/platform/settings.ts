// App settings, kept in localStorage so they are readable synchronously at
// first paint (theme, font size) without an async IndexedDB round-trip.
//
// The API key lives here too, which is a real tradeoff worth being honest
// about: a browser app with no accounts has nowhere else to put it. Anything
// running in this origin — including a devtools console on a shared school
// laptop — can read it. Settings says so out loud rather than implying the
// key is protected. It is deliberately NOT included in the settings export.

export type Provider = 'gemini' | 'lmstudio';
export type LongInputMethod = 'sample' | 'passes';

export interface Settings {
  provider: Provider;
  geminiKey: string;
  geminiModel: string;
  lmStudioUrl: string;
  lmStudioModel: string;
  /** Extra guidance appended to the Auto Flow sorting prompt. */
  autoFlowInstructions: string;
  /** Whether Analyze Round may work past the model's one-call length limit. */
  longInputAllowed: boolean;
  longInputMethod: LongInputMethod;
  theme: 'system' | 'light' | 'dark';
  affColor: string;
  negColor: string;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-flash-latest',
  lmStudioUrl: 'http://localhost:1234',
  lmStudioModel: '',
  autoFlowInstructions: '',
  longInputAllowed: false,
  longInputMethod: 'sample',
  theme: 'system',
  affColor: '#2563eb',
  negColor: '#dc2626',
};

const KEY = 'policyflow-settings';
export const SETTINGS_CHANGED_EVENT = 'policyflow-settings-changed';

// Fields that must never leave the app in an export or a share link.
const SECRET_FIELDS: (keyof Settings)[] = ['geminiKey'];

let cache: Settings | null = null;

export function readSettings(): Settings {
  if (cache) return cache;
  let stored: Partial<Settings> = {};
  try { stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { /* corrupt — fall back to defaults */ }
  // Normalize at READ time, not just at write time, so a value an older build
  // wrote badly (or a hand-edited localStorage) heals itself on next load
  // instead of misbehaving forever.
  cache = {
    ...DEFAULT_SETTINGS,
    ...stored,
    provider: stored.provider === 'lmstudio' ? 'lmstudio' : 'gemini',
    longInputMethod: stored.longInputMethod === 'passes' ? 'passes' : 'sample',
    theme: stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : 'system',
    autoFlowInstructions: String(stored.autoFlowInstructions ?? '').slice(0, 300),
  };
  return cache;
}

export function writeSettings(patch: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...patch };
  cache = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* quota or private mode */ }
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: next }));
  return next;
}

/** Settings minus every secret — what an export or a support paste may contain. */
export function exportableSettings(): Partial<Settings> {
  const out: Partial<Settings> = { ...readSettings() };
  for (const f of SECRET_FIELDS) delete out[f];
  return out;
}

/** True when the configured provider has enough to make a call. */
export function aiConfigured(s: Settings = readSettings()): boolean {
  return s.provider === 'gemini' ? !!s.geminiKey.trim() : !!s.lmStudioUrl.trim();
}
