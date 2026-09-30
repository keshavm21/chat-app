import { useLayoutEffect, useRef } from 'react';
import { hasOlder } from '../../lib/chatState';
import { Avatar, Spinner } from './icons';

// Within this many pixels of the bottom counts as "at the bottom": new messages scroll in.
const NEAR_BOTTOM_PX = 150;

const formatTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * One conversation's messages (keyed by it in pages/Conversation.jsx, so each starts
 * fresh), with "Load older" at the top and who is typing at the bottom. It opens at the
 * latest message, follows new ones while I am at the bottom (and always my own), and keeps
 * my place when older ones are added above.
 */
export default function MessageList({ timeline, myUserId, typingNames, onLoadOlder }) {
  const scrollRef = useRef(null);
  const nearBottomRef = useRef(true);
  const shownRef = useRef({ firstId: undefined, lastId: undefined, scrollHeight: 0 });
  const messages = timeline.messages;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const firstId = messages[0]?.id;
    const last = messages[messages.length - 1];
    const shown = shownRef.current;

    if (shown.lastId === undefined && last) {
      el.scrollTop = el.scrollHeight; // first render: the latest message
    } else if (firstId !== shown.firstId && last?.id === shown.lastId) {
      el.scrollTop += el.scrollHeight - shown.scrollHeight; // older ones above: stay put
    } else if (last && last.id !== shown.lastId && (nearBottomRef.current || last.userId === myUserId)) {
      el.scrollTop = el.scrollHeight;
    }
    shownRef.current = { firstId, lastId: last?.id, scrollHeight: el.scrollHeight };
  }, [messages, myUserId]);

  // Typing shows below the last message: keep it in view when I am at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [typingNames.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  // Consecutive messages from one person within a minute share one header.
  const grouped = messages.map((message, i) => {
    const prev = messages[i - 1];
    const isGrouped = !!prev && prev.userId === message.userId && new Date(message.createdAt) - new Date(prev.createdAt) < 60_000;
    return { ...message, isGrouped };
  });

  return (
    <main ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-4" aria-label="Messages">
      {timeline.status === 'loading' && messages.length === 0 ? (
        <div className="flex items-center justify-center h-full gap-2 text-slate-500 text-sm">
          <Spinner /> Loading messages…
        </div>
      ) : messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-2 text-center select-none">
          <p className="text-slate-400 text-sm font-medium">No messages yet</p>
          <p className="text-slate-600 text-xs">Be the first to say something 👋</p>
          <TypingIndicator names={typingNames} />
        </div>
      ) : (
        <div className="max-w-3xl mx-auto flex flex-col">
          {hasOlder(timeline) && (
            <div className="flex justify-center mb-2">
              <button
                onClick={onLoadOlder}
                disabled={timeline.loadingOlder}
                className="flex items-center gap-2 text-xs font-medium text-slate-400 hover:text-slate-200 px-3 py-1.5 rounded-lg border border-[#1f2937] hover:bg-white/5 disabled:opacity-60"
              >
                {timeline.loadingOlder && <Spinner size={12} />}
                Load older messages
              </button>
            </div>
          )}
          {grouped.map((message) => (
            <MessageBubble key={message.id} message={message} own={message.userId === myUserId} />
          ))}
          <TypingIndicator names={typingNames} />
        </div>
      )}
    </main>
  );
}

// Hover timestamps: a bubble that starts a group shows its time above it; later bubbles
// of the group show theirs on hover, positioned so nothing shifts.
function MessageBubble({ message, own }) {
  if (own) {
    return (
      <div className={`flex flex-col items-end ${message.isGrouped ? 'mt-0.5' : 'mt-4'} group`}>
        {!message.isGrouped && <span className="text-[11px] text-slate-600 mb-1 mr-1">{formatTime(message.createdAt)}</span>}
        <div className="relative max-w-[80%] sm:max-w-[70%] bg-indigo-600 text-white px-3.5 py-2 rounded-2xl rounded-tr-sm text-sm leading-relaxed break-words whitespace-pre-wrap">
          {message.isGrouped && (
            <span className="absolute -top-5 right-0 text-[10px] text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity duration-150 whitespace-nowrap pointer-events-none">
              {formatTime(message.createdAt)}
            </span>
          )}
          <span>{message.content}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-end gap-2.5 ${message.isGrouped ? 'mt-0.5' : 'mt-4'} group`}>
      {!message.isGrouped ? <Avatar name={message.username} /> : <div className="flex-none w-7" />}
      <div className="flex flex-col items-start max-w-[80%] sm:max-w-[70%]">
        {!message.isGrouped && (
          <div className="flex items-baseline gap-2 mb-1 ml-0.5">
            <span className="text-xs font-semibold text-slate-300">{message.username}</span>
            <span className="text-[11px] text-slate-600">{formatTime(message.createdAt)}</span>
          </div>
        )}
        <div className="relative bg-[#1a2234] border border-[#252d3d] text-slate-200 px-3.5 py-2 rounded-2xl rounded-tl-sm text-sm leading-relaxed break-words whitespace-pre-wrap">
          {message.isGrouped && (
            <span className="absolute -top-5 left-0 text-[10px] text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity duration-150 whitespace-nowrap pointer-events-none">
              {formatTime(message.createdAt)}
            </span>
          )}
          <span>{message.content}</span>
        </div>
      </div>
    </div>
  );
}

function TypingIndicator({ names }) {
  if (!names.length) return null;
  const label =
    names.length === 1 ? `${names[0]} is typing`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing`
        : 'Several people are typing';
  return (
    <div className="flex items-center gap-2.5 mt-3" aria-live="polite">
      <div className="flex-none w-7" />
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          {[0, 150, 300].map((delay) => (
            <span key={delay} className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: `${delay}ms` }} />
          ))}
        </div>
        <span className="text-slate-500 text-xs">{label}</span>
      </div>
    </div>
  );
}
