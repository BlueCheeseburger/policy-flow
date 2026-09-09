// capForPrompt — the only sanctioned way to shorten something on its way into a
// prompt, and it ASKS FIRST.
//
// A bare `text.slice(0, N)` is the failure this exists to prevent: it drops
// most of a long document and the user gets a confidently wrong answer with no
// idea two-thirds of their evidence was never sent. Where a task can be
// batched (Auto Flow's classify and summarize steps) it is batched instead;
// this is for the cases that genuinely need one coherent blob — a whole flow
// in one head. It blocks on a modal, and if the user declines it throws rather
// than spending the call on partial input.
//
// `label` is what the USER calls that input ("your flow", "this doc"), never
// an internal field name.

export const TRUNCATION_DECLINED = 'TRUNCATION_DECLINED';

export interface TruncationAsk {
  id: number;
  label: string;
  kept: number;
  total: number;
}

export const TRUNCATION_ASK_EVENT = 'policyflow-truncation-ask';

let nextId = 1;
const pending = new Map<number, (proceed: boolean) => void>();

/** Answer an outstanding ask. Called by the modal. */
export function resolveTruncationAsk(id: number, proceed: boolean): void {
  const resolve = pending.get(id);
  if (!resolve) return;
  pending.delete(id);
  resolve(proceed);
}

/** True when nobody is listening, so we can fail loudly instead of hanging. */
let listenerCount = 0;
export function registerTruncationListener(): () => void {
  listenerCount++;
  return () => { listenerCount--; };
}

export async function capForPrompt(text: string, limit: number, label: string): Promise<string> {
  const s = String(text ?? '');
  if (s.length <= limit) return s;

  // No modal mounted to ask with. Fail closed rather than quietly spending the
  // call on partial input — the user would never learn what was dropped.
  if (listenerCount === 0) throw new Error(TRUNCATION_DECLINED);

  const id = nextId++;
  const proceed = await new Promise<boolean>((resolve) => {
    pending.set(id, resolve);
    window.dispatchEvent(new CustomEvent<TruncationAsk>(TRUNCATION_ASK_EVENT, {
      detail: { id, label, kept: limit, total: s.length },
    }));
  });

  if (!proceed) throw new Error(TRUNCATION_DECLINED);
  return s.slice(0, limit);
}
