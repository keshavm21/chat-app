import { WarningIcon } from './icons';

// Toasts appear bottom-right, above the composer, and go after a few seconds (ChatProvider).
export default function Toasts({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-24 right-4 z-50 flex flex-col gap-2 pointer-events-none" role="status">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-[#1a2234] border border-red-500/30 text-red-400 text-sm shadow-lg backdrop-blur-sm fade-in-up"
        >
          <WarningIcon />
          {t.message}
        </div>
      ))}
    </div>
  );
}
