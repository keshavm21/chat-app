// Small inline icons for the chat pages (stroke icons inherit the text color).

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };

export function Logo({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M4 8C4 6.343 5.343 5 7 5H25C26.657 5 28 6.343 28 8V20C28 21.657 26.657 23 25 23H18L12 28V23H7C5.343 23 4 21.657 4 20V8Z"
        fill="#818cf8" opacity="0.9"
      />
      <circle cx="11" cy="14" r="1.5" fill="white" opacity="0.6" />
      <circle cx="16" cy="14" r="1.5" fill="white" opacity="0.6" />
      <circle cx="21" cy="14" r="1.5" fill="white" opacity="0.6" />
    </svg>
  );
}

export function HashIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" /><line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}

export function LockIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function PlusIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function SearchIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function MenuIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function SendIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={2.5} aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

export function WarningIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} className="flex-none opacity-80" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function Spinner({ size = 16 }) {
  return (
    <svg className="animate-spin" width={size} height={size} fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

/** A user's initial in a circle. */
export function Avatar({ name, size = 'w-7 h-7' }) {
  return (
    <div className={`flex-none ${size} rounded-full bg-slate-700 border border-slate-600/50 flex items-center justify-center text-slate-300 text-xs font-semibold select-none`}>
      {name?.[0]?.toUpperCase()}
    </div>
  );
}

/** The mark before a conversation's name: # for a public channel, a lock for a private one, an avatar for a DM. */
export function ConversationMark({ conversation }) {
  if (conversation.type === 'dm') return <Avatar name={conversation.name} size="w-5 h-5" />;
  return conversation.visibility === 'private' ? <LockIcon /> : <HashIcon />;
}
