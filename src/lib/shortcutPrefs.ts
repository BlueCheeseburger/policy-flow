// Central registry for every rebindable/disableable keyboard shortcut, keyed
// by the stable `id` used in ShortcutsOverlay.tsx's GROUPS array. Two things
// live here, both per-user and localStorage-backed:
//   - disabled:  a Set<string> of ids the user turned off entirely
//   - bindings:  a Record<string, KeyBinding> of ids the user rebound to a
//                different key combo (only for ids with a DEFAULT_BINDINGS
//                entry — "core convention" shortcuts like Enter/Tab/arrows,
//                and multi-key groups like the sheet-switcher, aren't in the
//                registry and stay fixed)
//
// Every consuming keydown handler should call matchesShortcut(e, id) instead
// of hand-rolling its own key comparison — that's what makes rebinding and
// disabling actually take effect everywhere the shortcut is wired up.

export interface KeyBinding { mod: boolean; shift: boolean; alt: boolean; key: string; }

// The one source of truth for each rebindable shortcut's default combo.
// `key` is always e.key.toLowerCase() as it would appear in a KeyboardEvent.
export const DEFAULT_BINDINGS: Record<string, KeyBinding> = {
  'global-search':     { mod: true, shift: false, alt: false, key: 'k' },
  'shortcuts-overlay': { mod: true, shift: false, alt: false, key: '/' },
  'find-page':         { mod: true, shift: false, alt: false, key: 'f' },
  'flow-bold':         { mod: true, shift: false, alt: false, key: 'b' },
  'flow-italic':       { mod: true, shift: false, alt: false, key: 'i' },
  'flow-underline':    { mod: true, shift: false, alt: false, key: 'u' },
  'flow-strike':       { mod: true, shift: true,  alt: false, key: 'x' },
  'flow-highlight':    { mod: true, shift: true,  alt: false, key: 'h' },
  'flow-undo':         { mod: true, shift: false, alt: false, key: 'z' },
  'flow-redo':         { mod: true, shift: true,  alt: false, key: 'z' },
  'flow-link':         { mod: true, shift: false, alt: false, key: 'l' },
  'flow-sheet-new':    { mod: true, shift: false, alt: false, key: 't' },
  'doc-insert-comment': { mod: true, shift: false, alt: true, key: 'm' },
};

const DISABLED_KEY = 'warroom-disabled-shortcuts';
const BINDINGS_KEY = 'warroom-shortcut-bindings';

function readDisabled(): Set<string> {
  try {
    const raw = localStorage.getItem(DISABLED_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

export function isShortcutDisabled(id: string): boolean {
  return readDisabled().has(id);
}

export function toggleShortcutDisabled(id: string): boolean {
  const set = readDisabled();
  const nowDisabled = !set.has(id);
  if (nowDisabled) set.add(id); else set.delete(id);
  try { localStorage.setItem(DISABLED_KEY, JSON.stringify([...set])); } catch { /* ignore */ }
  return nowDisabled;
}

export function getDisabledShortcuts(): Set<string> {
  return readDisabled();
}

function readBindings(): Record<string, KeyBinding> {
  try {
    const raw = localStorage.getItem(BINDINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeBindings(bindings: Record<string, KeyBinding>) {
  try { localStorage.setItem(BINDINGS_KEY, JSON.stringify(bindings)); } catch { /* ignore */ }
}

/** The binding actually in effect for `id` — custom override if set, else the default. Null if `id` isn't a registered shortcut. */
export function getEffectiveBinding(id: string): KeyBinding | null {
  const custom = readBindings()[id];
  return custom ?? DEFAULT_BINDINGS[id] ?? null;
}

export function hasCustomBinding(id: string): boolean {
  return id in readBindings();
}

/** A binding must include a real modifier (⌘/Ctrl or ⌥) — Shift alone isn't
 *  enough, since Shift+letter is just typing a capital letter. Without this,
 *  a rebound shortcut could silently eat normal typing in any text field
 *  (flow cells, chat composers, etc). */
export function isBindingValid(b: KeyBinding): boolean {
  return (b.mod || b.alt) && b.key.length > 0;
}

/** Sets a custom binding for `id`. Returns false (and does not save) if the
 *  binding is invalid or already in use by a different, currently-enabled
 *  registered shortcut. */
export function setCustomBinding(id: string, binding: KeyBinding): boolean {
  if (!isBindingValid(binding)) return false;
  const conflict = findConflict(id, binding);
  if (conflict) return false;
  const bindings = readBindings();
  bindings[id] = binding;
  writeBindings(bindings);
  return true;
}

export function resetBinding(id: string) {
  const bindings = readBindings();
  delete bindings[id];
  writeBindings(bindings);
}

/** Returns the id of another enabled, registered shortcut already using this
 *  exact binding, or null if there's no conflict. */
export function findConflict(excludeId: string, binding: KeyBinding): string | null {
  for (const id of Object.keys(DEFAULT_BINDINGS)) {
    if (id === excludeId || isShortcutDisabled(id)) continue;
    const b = getEffectiveBinding(id);
    if (b && bindingsEqual(b, binding)) return id;
  }
  return null;
}

function bindingsEqual(a: KeyBinding, b: KeyBinding): boolean {
  return a.mod === b.mod && a.shift === b.shift && a.alt === b.alt && a.key.toLowerCase() === b.key.toLowerCase();
}

// Structural type covering both native KeyboardEvent (window.addEventListener
// handlers) and React's synthetic KeyboardEvent<T> (per-cell onKeyDown props
// in FlowView.tsx) — every consumer here only ever reads these fields.
interface KeyEventLike { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string; }

/** Builds a KeyBinding from a live keydown event (for recording a rebind). */
export function bindingFromEvent(e: KeyEventLike): KeyBinding {
  return { mod: e.metaKey || e.ctrlKey, shift: e.shiftKey, alt: e.altKey, key: e.key.toLowerCase() };
}

function eventMatchesBinding(e: KeyEventLike, b: KeyBinding): boolean {
  const mod = e.metaKey || e.ctrlKey;
  return mod === b.mod && e.shiftKey === b.shift && e.altKey === b.alt && e.key.toLowerCase() === b.key.toLowerCase();
}

/** The one check every keydown handler should use: true if `e` triggers the
 *  registered shortcut `id` — accounting for disable state and any custom
 *  rebind. Returns false for unregistered ids (nothing to match against). */
export function matchesShortcut(e: KeyEventLike, id: string): boolean {
  if (isShortcutDisabled(id)) return false;
  const b = getEffectiveBinding(id);
  if (!b) return false;
  return eventMatchesBinding(e, b);
}

/** Renders a binding as the single-glyph-string style already used throughout
 *  the app, e.g. "⌘⇧X". `mod` is spelled out as "Ctrl" on Windows, matching
 *  ShortcutsOverlay.tsx's existing convention (glued directly to the rest,
 *  no separator — that's the established look, not a bug). */
export function formatBinding(b: KeyBinding, modGlyph: string): string {
  const key = b.key === '/' ? '/' : b.key.toUpperCase();
  return `${b.mod ? modGlyph : ''}${b.shift ? '⇧' : ''}${b.alt ? '⌥' : ''}${key}`;
}
