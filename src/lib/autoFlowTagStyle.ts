// Shared style preference for Auto Flow's write step (src/components/AutoFlow.tsx)
// and its live-preview settings card (src/components/Settings.tsx — "Auto Flow
// tag style"). Kept in one place so the two never drift on the storage key, JSON
// shape, or defaults.
//
// NOTE: `color` and `fontSize` are captured here and shown in the Settings live
// preview, but Auto Flow's write step does NOT apply them to a flow cell — flow
// cells only support the emphasis in src/lib/cellHtml.ts's ALLOWED_TAGS /
// ALLOWED_STYLE_PROPS (bold/italic/underline/strike; no per-run color or font
// size — see that file's comment on why: there's no text-color picker in a flow
// and cell font size is a view-level setting, not a per-cell one). Anything else
// written into a cell is silently stripped the next time the flow renders, so
// only bold/italic/underline actually reach the cell. color/fontSize still live
// here so the Settings preview honestly shows everything the user asked for,
// including the part that can't take effect in a cell yet.
export interface AutoFlowTagStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string | null;
  fontSize: number;
}

export const AUTOFLOW_STYLE_KEY = 'warroom-autoflow-tag-style';
export const AUTOFLOW_STYLE_CHANGED_EVENT = 'warroom-autoflow-style-changed';

export const AUTOFLOW_STYLE_DEFAULTS: AutoFlowTagStyle = {
  bold: true,
  italic: false,
  underline: false,
  color: null,
  fontSize: 13,
};

export function readAutoFlowTagStyle(): AutoFlowTagStyle {
  try {
    const raw = localStorage.getItem(AUTOFLOW_STYLE_KEY);
    if (!raw) return { ...AUTOFLOW_STYLE_DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      bold: typeof parsed.bold === 'boolean' ? parsed.bold : AUTOFLOW_STYLE_DEFAULTS.bold,
      italic: typeof parsed.italic === 'boolean' ? parsed.italic : AUTOFLOW_STYLE_DEFAULTS.italic,
      underline: typeof parsed.underline === 'boolean' ? parsed.underline : AUTOFLOW_STYLE_DEFAULTS.underline,
      color: typeof parsed.color === 'string' ? parsed.color : null,
      fontSize: typeof parsed.fontSize === 'number' && parsed.fontSize > 0 ? parsed.fontSize : AUTOFLOW_STYLE_DEFAULTS.fontSize,
    };
  } catch {
    return { ...AUTOFLOW_STYLE_DEFAULTS };
  }
}

export function writeAutoFlowTagStyle(style: AutoFlowTagStyle): void {
  localStorage.setItem(AUTOFLOW_STYLE_KEY, JSON.stringify(style));
  window.dispatchEvent(new CustomEvent(AUTOFLOW_STYLE_CHANGED_EVENT));
}
