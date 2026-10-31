import { Handshake } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.ts';
import { cx, Spinner } from '../ui.tsx';

/** Opens the case this source already started, or creates it; repeated clicks never make a second one. */
export function StartCase({ source, className, label = '发起协作' }: { source: { signalId: string } | { turnId: string; findingId: string }; className?: string; label?: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await api<{ id: string; created: boolean }>('/api/cases', { method: 'POST', body: source });
      navigate(`/cases/${id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        className={cx('inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-60', className)}
      >
        {busy ? <Spinner className="size-3.5" /> : <Handshake className="size-4" />}
        {label}
      </button>
      {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
