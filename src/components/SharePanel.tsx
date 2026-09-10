import React, { useState } from 'react';
import { shareUrl } from '../platform/cloud';

/**
 * Sharing a flow means handing out a link. There are no accounts to send it to
 * and no invitations to accept: anyone who opens the link is in the room and
 * can edit, for as long as the link exists.
 *
 * That is a real tradeoff, not a detail, so the panel says it in plain words
 * before the link is created rather than burying it. A debater who pastes this
 * into a public thread has published their flow.
 */
export default function SharePanel({
  name, live, shareToken, starting, onGoLive, onExportXlsx, onClose,
}: {
  name: string;
  live: boolean;
  shareToken?: string;
  starting: boolean;
  onGoLive: () => Promise<{ ok: boolean; shareToken?: string; error?: string }>;
  onExportXlsx: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [token, setToken] = useState<string | undefined>(live ? shareToken : undefined);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const url = token ? shareUrl(token) : '';

  async function goLive() {
    setError('');
    const res = await onGoLive();
    if (!res.ok) { setError(res.error ?? 'Could not create the room.'); return; }
    setToken(res.shareToken);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused (an insecure origin, or a permission
      // prompt the user dismissed). The link is selectable either way.
      setError('Could not copy automatically — select the link and copy it.');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border shadow-xl p-5 flex flex-col gap-4"
        style={{ background: 'var(--bg-main)', borderColor: 'var(--border-color)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Share ${name}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Share this flow</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--label-color)' }}>{name}</p>
          </div>
          <button className="btn px-2 py-0.5 text-sm" onClick={onClose} title="Close">✕</button>
        </div>

        {!token ? (
          <>
            <p className="text-sm leading-relaxed">
              Turning this into a room creates a link. <strong>Anyone who has that link can
              read and edit this flow</strong> — there is no password, and it does not expire.
              Share it only with people you would hand your flow to.
            </p>
            <button className="btn btn-primary w-full py-2" onClick={goLive} disabled={starting}>
              {starting ? 'Creating room…' : 'Create a share link'}
            </button>
          </>
        ) : (
          <>
            <p className="text-sm">
              This flow is live. Everyone with the link edits it with you, in the same room.
            </p>
            <div className="flex gap-2">
              <input
                className="input flex-1 text-xs font-mono"
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Share link"
              />
              <button className="btn px-3" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          </>
        )}

        {error && (
          <p className="text-sm" style={{ color: 'var(--danger)' }} role="alert">{error}</p>
        )}

        <div className="pt-2 border-t" style={{ borderColor: 'var(--border-color)' }}>
          <button className="btn w-full py-2" onClick={() => void onExportXlsx()}>
            Download as .xlsx
          </button>

        </div>
      </div>
    </div>
  );
}
