import { useEffect, useRef } from 'react';
import { CloseIcon } from './icons';

/**
 * A modal dialog: a titled panel over a dimmed page. Escape, the close button and a click
 * outside the panel close it; the first field (or the panel) gets the focus.
 */
export default function Dialog({ title, onClose, children, wide = false }) {
  const panelRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const field = panelRef.current?.querySelector('input, textarea, select');
    (field ?? panelRef.current)?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/60 backdrop-blur-sm px-4 pt-16 sm:pt-0"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`w-full ${wide ? 'max-w-lg' : 'max-w-md'} rounded-2xl bg-[#0d1117] border border-[#1f2937] card-glow fade-in-up outline-none`}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[#1f2937]">
          <h2 className="text-white text-base font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-slate-500 hover:text-slate-300 p-1 rounded-lg hover:bg-white/5">
            <CloseIcon />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

/** A form's error line, from the server's message. */
export function FormError({ message }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
      {message}
    </p>
  );
}

// Shared field and button looks for the dialogs.
export const inputClass =
  'w-full bg-[#111827] border border-[#1f2937] rounded-xl px-3.5 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 outline-none transition-colors focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/20';
export const primaryButtonClass =
  'px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors';
export const secondaryButtonClass =
  'px-4 py-2 rounded-xl border border-[#1f2937] hover:bg-white/5 text-slate-300 text-sm font-medium transition-colors';
