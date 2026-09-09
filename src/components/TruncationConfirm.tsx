import React, { useEffect, useState } from 'react';
import {
  TRUNCATION_ASK_EVENT, resolveTruncationAsk, registerTruncationListener,
  type TruncationAsk,
} from '../platform/longInputGate';

/**
 * The "this is too long to send in one piece" prompt.
 *
 * It exists so nothing is ever silently cut. A prompt built from two-thirds of
 * a document produces a confidently wrong answer that looks exactly like a
 * right one, and the user would have no way to know. So the cut is shown, with
 * real numbers, BEFORE the call is made — and declining cancels the call
 * rather than quietly proceeding on partial input.
 */
export default function TruncationConfirm() {
  const [ask, setAsk] = useState<TruncationAsk | null>(null);

  useEffect(() => {
    const unregister = registerTruncationListener();
    const onAsk = (e: Event) => setAsk((e as CustomEvent<TruncationAsk>).detail);
    window.addEventListener(TRUNCATION_ASK_EVENT, onAsk);
    return () => {
      window.removeEventListener(TRUNCATION_ASK_EVENT, onAsk);
      unregister();
    };
  }, []);

  if (!ask) return null;

  const answer = (proceed: boolean) => { resolveTruncationAsk(ask.id, proceed); setAsk(null); };
  const pct = Math.round((ask.kept / ask.total) * 100);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4">
      <div
        className="w-full max-w-md rounded-xl border shadow-xl p-5 flex flex-col gap-4"
        style={{ background: 'var(--bg-main)', borderColor: 'var(--border-color)' }}
        role="alertdialog"
        aria-modal="true"
      >
        <h2 className="text-base font-semibold">{ask.label} is too long to send whole</h2>
        <p className="text-sm leading-relaxed">
          Only about <strong>{pct}%</strong> of it fits in one request
          ({ask.kept.toLocaleString()} of {ask.total.toLocaleString()} characters).
          If you continue, the rest is <strong>not sent</strong> — the answer will be based
          on the first part only.
        </p>
        <div className="flex gap-2 justify-end">
          <button className="btn px-3 py-1.5" onClick={() => answer(false)}>Cancel</button>
          <button className="btn btn-primary px-3 py-1.5" onClick={() => answer(true)}>
            Send the first {pct}%
          </button>
        </div>
      </div>
    </div>
  );
}
