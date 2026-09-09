// The AI transport. In Warroom this lived in the Electron main process, which
// had no CSP and held the key in the OS keychain. Here the call goes straight
// from the page to the provider, so only providers that allow a browser origin
// are offered:
//
//   • Gemini — sends CORS headers on generativelanguage.googleapis.com, so a
//     direct browser call works with no proxy.
//   • LM Studio — the user's own machine. The page is HTTPS and LM Studio is
//     http://localhost, which Chrome/Edge/Firefox permit because localhost
//     counts as a trustworthy origin; Safari blocks it. LM Studio's own CORS
//     setting also has to be on. Settings says both things plainly.
//
// Everything below preserves the failure rules the desktop app was built
// against: the provider's own error text is surfaced verbatim, a response the
// provider cut off throws instead of being parsed as a bad answer, and an
// unparseable reply is never laundered into an empty-but-successful result.

import { readSettings, type Settings } from './settings';

export type ModelTier = 'lite' | 'balanced' | 'best';

// ── Truncation ───────────────────────────────────────────────────────────────
// `TRUNCATED:` is the marker isTruncatedResponse matches on. A caller that
// parses JSON must let this propagate: the fix is a smaller batch, not a retry.
export function truncatedResponseError(provider: string, partial: string): Error {
  const chars = (partial ?? '').length;
  return new Error(
    `TRUNCATED: ${provider} cut the response off at its output-token limit ` +
    `(got ${chars.toLocaleString()} characters, ending: “…${(partial ?? '').slice(-80).trim()}”). ` +
    `The request was too large to answer in one call.`,
  );
}

export function isTruncatedResponse(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith('TRUNCATED:');
}

export class NoKeyError extends Error {
  constructor(message: string) { super(message); this.name = 'NoKeyError'; }
}

// ── Loose JSON parsing ───────────────────────────────────────────────────────
export function parseJsonLoose(raw: string): any {
  const cleaned = (raw ?? '').replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/m, '').trim();
  try { return JSON.parse(cleaned); } catch { /* try to find an embedded value */ }
  const os = cleaned.indexOf('{'), oe = cleaned.lastIndexOf('}');
  if (os !== -1 && oe > os) { try { return JSON.parse(cleaned.slice(os, oe + 1)); } catch { /* keep looking */ } }
  const as = cleaned.indexOf('['), ae = cleaned.lastIndexOf(']');
  if (as !== -1 && ae > as) { try { return JSON.parse(cleaned.slice(as, ae + 1)); } catch { /* give up */ } }
  return null;
}

// ── Gemini ───────────────────────────────────────────────────────────────────
function geminiHttpError(status: number, body: string): Error {
  let parsed: any;
  try { parsed = JSON.parse(body)?.error; } catch { /* not JSON */ }
  if (parsed?.message) {
    return new Error(`Gemini [${status}${parsed.status ? ' ' + parsed.status : ''}]: ${parsed.message}`);
  }
  if (status === 429) return new Error('Rate limit reached — wait a moment and try again.');
  if (status === 503) return new Error('The model is overloaded right now. Try again in a few seconds.');
  if (status === 403 || status === 400) return new Error(`The request was rejected (HTTP ${status}) — check your API key in Settings.`);
  return new Error(`The request failed (HTTP ${status}) — try again shortly.`);
}

const GEMINI_TIER_MODEL: Record<ModelTier, string> = {
  lite: 'gemini-flash-lite-latest',
  balanced: 'gemini-flash-latest',
  best: 'gemini-flash-latest',
};

async function callGemini(s: Settings, prompt: string, tier: ModelTier, maxOutputTokens: number): Promise<string> {
  const key = s.geminiKey.trim();
  if (!key) throw new NoKeyError('No API key set. Add one in Settings to use anything that calls a model.');
  // The user's chosen model wins for the tiers that do real reasoning; the
  // 'lite' tier stays on the cheapest model since it only writes one sentence.
  const modelId = tier === 'lite' ? GEMINI_TIER_MODEL.lite : (s.geminiModel.trim() || GEMINI_TIER_MODEL.balanced);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens },
    }),
  }).catch((e) => {
    // A network-level failure here is usually CORS, an offline machine, or a
    // VPN/proxy that can't reach the endpoint. fetch gives no detail, so say
    // what is actually knowable rather than inventing a cause.
    throw new Error(`Could not reach the model (${e?.message || 'network error'}). Check your connection — a VPN or content blocker can also break this request.`);
  });
  if (!res.ok) throw geminiHttpError(res.status, await res.text().catch(() => ''));
  const data: any = await res.json();
  const cand = data?.candidates?.[0];
  const text = cand?.content?.parts?.map((p: any) => p?.text).filter((t: any) => typeof t === 'string').join('') ?? '';
  if (cand?.finishReason === 'MAX_TOKENS') throw truncatedResponseError('Gemini', text);
  if (!text) {
    const blocked = data?.promptFeedback?.blockReason;
    throw new Error(blocked ? `The model refused the request (${blocked}).` : 'The model returned an empty response.');
  }
  return text;
}

// ── LM Studio (OpenAI-compatible, on the user's own machine) ─────────────────
async function callLmStudio(s: Settings, prompt: string, maxOutputTokens: number): Promise<string> {
  const base = s.lmStudioUrl.trim().replace(/\/+$/, '');
  if (!base) throw new NoKeyError('No LM Studio address set. Add one in Settings.');
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: s.lmStudioModel || 'local-model',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: maxOutputTokens,
    }),
  }).catch((e) => {
    throw new Error(
      `Could not reach LM Studio at ${base} (${e?.message || 'network error'}). ` +
      `Make sure the local server is running and that its CORS setting is on. Safari blocks this entirely — use Chrome or Firefox.`,
    );
  });
  if (!res.ok) throw new Error(`LM Studio [${res.status}]: ${(await res.text().catch(() => '')).slice(0, 300) || 'request failed'}`);
  const data: any = await res.json();
  const choice = data?.choices?.[0];
  const text = choice?.message?.content ?? '';
  if (choice?.finish_reason === 'length') throw truncatedResponseError('LM Studio', text);
  if (typeof text !== 'string' || !text) throw new Error('LM Studio returned an empty response.');
  return text;
}

/** List the models LM Studio currently has loaded. Used by Settings' picker. */
export async function listLmStudioModels(url: string): Promise<string[]> {
  const base = url.trim().replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/models`);
  if (!res.ok) throw new Error(`LM Studio [${res.status}] — could not list models.`);
  const data: any = await res.json();
  return (data?.data ?? []).map((m: any) => String(m?.id ?? '')).filter(Boolean);
}

// ── The one entry point ──────────────────────────────────────────────────────
export async function callAI(
  prompt: string,
  tier: ModelTier,
  extra?: { maxOutputTokens?: number },
): Promise<string> {
  const s = readSettings();
  const maxOutputTokens = extra?.maxOutputTokens ?? 8192;
  return s.provider === 'lmstudio'
    ? callLmStudio(s, prompt, maxOutputTokens)
    : callGemini(s, prompt, tier, maxOutputTokens);
}

// ── Prompt rendering ─────────────────────────────────────────────────────────
// The prompts stay as their own .txt files (imported raw by Vite) rather than
// inline template strings, so each one is diffable on its own and can be shown
// verbatim in Settings the way the desktop app's prompt editor did.
import autoFlowClassify from '../prompts/auto_flow_classify.txt?raw';
import autoFlowSummarize from '../prompts/auto_flow_summarize.txt?raw';
import summarizeFlowSheet from '../prompts/summarize_flow_sheet.txt?raw';
import analyzeRound from '../prompts/analyze_round.txt?raw';
import analyzeRoundPass from '../prompts/analyze_round_pass.txt?raw';
import flowImport from '../prompts/flow_import.txt?raw';

const PROMPTS: Record<string, string> = {
  auto_flow_classify: autoFlowClassify,
  auto_flow_summarize: autoFlowSummarize,
  summarize_flow_sheet: summarizeFlowSheet,
  analyze_round: analyzeRound,
  analyze_round_pass: analyzeRoundPass,
  flow_import: flowImport,
};

export function promptNames(): string[] { return Object.keys(PROMPTS); }
export function promptSource(name: string): string { return PROMPTS[name] ?? ''; }

export function renderPrompt(name: string, vars: Record<string, string>): string {
  const src = PROMPTS[name];
  if (!src) throw new Error(`Unknown prompt "${name}".`);
  return src.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, k) => vars[k] ?? '');
}
