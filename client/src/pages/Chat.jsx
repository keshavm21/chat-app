
import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth }      from '../context/useAuth';
import socket           from '../socket';
import api              from '../api/axios';

// ─── Toast Container ───────────────────────────────────────────────────────────
// Toasts appear bottom-right, above the input bar, and auto-dismiss after 4 s.
function ToastContainer({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-20 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl
                     bg-[#1a2234] border border-red-500/30 text-red-400
                     text-sm shadow-lg backdrop-blur-sm fade-in-up"
        >
          {/* Warning icon */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className="flex-none opacity-80"
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ─── Chat Page ─────────────────────────────────────────────────────────────────
export default function Chat() {
  const { user, logout } = useAuth();

  const [messages,     setMessages]     = useState([]);
  const [text,         setText]         = useState('');
  const [onlineCount,  setOnlineCount]  = useState(0);
  const [loading,      setLoading]      = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [toasts,       setToasts]       = useState([]);
  const [typingUsers,  setTypingUsers]  = useState([]);

  const bottomRef  = useRef(null);
  const textareaRef = useRef(null);
  const mainRef    = useRef(null);   // scroll container — used for nearBottom detection
  const nearBottom = useRef(true);  // true when the user is at/near the bottom of the feed

  // ── Toast helper ──────────────────────────────────────────────────────────
  const addToast = useCallback((message) => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  // ── Smart scroll ──────────────────────────────────────────────────────────
  // Only scrolls when the user is already near the bottom, unless force=true
  // (used right after the initial history fetch so the last message is visible).
  const scrollToBottom = useCallback((force = false) => {
    if (force || nearBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  // Keep nearBottom in sync as the user scrolls through history.
  const handleScroll = useCallback(() => {
    const el = mainRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottom.current = dist < 150;
  }, []);

  // After history finishes loading, force-scroll once so the latest message shows.
  useEffect(() => {
    if (!loading) scrollToBottom(true);
  }, [loading, scrollToBottom]);

  // For live incoming messages: scroll only when the user is near the bottom.
  useEffect(() => {
    if (messages.length) scrollToBottom();
  }, [messages, scrollToBottom]);

  // ── Fetch message history on mount ────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/api/messages');
        setMessages(data.messages || []);
      } catch {
        setHistoryError('Could not load message history.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ── Socket lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    socket.connect();

    socket.on('message', (msg) => {
      setMessages(prev => [...prev, msg]);
    });

    socket.on('online_count', (count) => {
      setOnlineCount(count);
    });

    // Surface server-side failures as toasts instead of silent drops.
    socket.on('error', ({ message }) => {
      addToast(message || 'Something went wrong. Please try again.');
    });

    // Typing indicator — server broadcasts username strings.
    socket.on('user_typing', (username) => {
      setTypingUsers(prev =>
        prev.includes(username) ? prev : [...prev, username]
      );
    });
    socket.on('user_stop_typing', (username) => {
      setTypingUsers(prev => prev.filter(u => u !== username));
    });

    socket.on('connect_error', (err) => {
      console.error('Socket error:', err.message);
      if (err.message.toLowerCase().includes('authentication')) {
        // The session expired or was revoked: log out, and ProtectedRoute
        // redirects to /login.
        logout();
      } else {
        addToast('Connection lost. Reconnecting…');
      }
    });

    return () => {
      socket.off('message');
      socket.off('online_count');
      socket.off('error');
      socket.off('user_typing');
      socket.off('user_stop_typing');
      socket.off('connect_error');
      socket.disconnect();
    };
  }, [logout, addToast]);

  // ── Send a message ────────────────────────────────────────────────────────
  const sendMessage = () => {
    const trimmed = text.trim();
    if (!trimmed || !socket.connected) return;
    socket.emit('new_message', { content: trimmed });
    setText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleTextChange = (e) => {
    setText(e.target.value);
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    }
    // Notify the server on every keystroke; the server debounces and
    // auto-clears after 3 s so we never need to emit a "stop typing" event.
    if (e.target.value.trim() && socket.connected) {
      socket.emit('typing');
    }
  };

  // Once logged out, ProtectedRoute redirects to /login.
  const handleLogout = () => { logout(); };

  // ── Derived display data ──────────────────────────────────────────────────
  // Group consecutive messages from the same user (within 60 s) to avoid
  // repeating the avatar / username header for every single bubble.
  const grouped = messages.map((msg, i) => {
    const prev = messages[i - 1];
    const isGrouped =
      prev &&
      prev.userId === msg.userId &&
      new Date(msg.createdAt) - new Date(prev.createdAt) < 60_000;
    return { ...msg, isGrouped };
  });

  const isOwn = (msg) => String(msg.userId) === String(user?.id);

  const fmt = (iso) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Build the "X is typing…" label shown below the message list.
  const typingLabel = (() => {
    if (!typingUsers.length) return null;
    if (typingUsers.length === 1) return `${typingUsers[0]} is typing`;
    if (typingUsers.length === 2) return `${typingUsers[0]} and ${typingUsers[1]} are typing`;
    return 'Several people are typing';
  })();

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen bg-[#0a0b14] flex flex-col overflow-hidden">

      <ToastContainer toasts={toasts} />

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="flex-none h-14 border-b border-[#1f2937] bg-[#0d1117]/90 backdrop-blur-sm flex items-center justify-between px-5 z-10">

        <div className="flex items-center gap-3">
          {/* Logo + wordmark */}
          <div className="flex items-center gap-2">
            <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
              <path
                d="M4 8C4 6.343 5.343 5 7 5H25C26.657 5 28 6.343 28 8V20C28 21.657 26.657 23 25 23H18L12 28V23H7C5.343 23 4 21.657 4 20V8Z"
                fill="#818cf8" opacity="0.9"
              />
              <circle cx="11" cy="14" r="1.5" fill="white" opacity="0.6" />
              <circle cx="16" cy="14" r="1.5" fill="white" opacity="0.6" />
              <circle cx="21" cy="14" r="1.5" fill="white" opacity="0.6" />
            </svg>
            <span
              className="font-bold text-white text-[15px]"
              style={{ fontFamily: 'Syne, sans-serif' }}
            >
              Relay
            </span>
          </div>

          {/* Online count — hidden on very small screens */}
          <div className="hidden sm:flex items-center gap-1.5 pl-3 border-l border-[#1f2937] ml-0.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-slate-400 text-xs">
              {onlineCount} {onlineCount === 1 ? 'person' : 'people'} online
            </span>
          </div>
        </div>

        {/* User pill + logout */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-300 text-xs font-bold select-none">
              {user?.username?.[0]?.toUpperCase()}
            </div>
            <span className="text-slate-300 text-sm hidden sm:inline">
              {user?.username}
            </span>
          </div>
          <button
            onClick={handleLogout}
            className="text-slate-500 hover:text-slate-300 text-xs font-medium transition-colors px-2.5 py-1.5 rounded-lg hover:bg-white/5 border border-transparent hover:border-white/10"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* ── Message area ────────────────────────────────────────────────── */}
      <main
        ref={mainRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {loading ? (
          /* Loading spinner */
          <div className="flex items-center justify-center h-full gap-2 text-slate-500 text-sm">
            <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Loading messages…
          </div>

        ) : historyError ? (
          /* Error state */
          <div className="flex items-center justify-center h-full">
            <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {historyError}
            </div>
          </div>

        ) : messages.length === 0 ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center select-none">
            <div className="w-14 h-14 rounded-2xl bg-indigo-600/10 border border-indigo-500/20 flex items-center justify-center">
              <svg width="26" height="26" viewBox="0 0 32 32" fill="none">
                <path
                  d="M4 8C4 6.343 5.343 5 7 5H25C26.657 5 28 6.343 28 8V20C28 21.657 26.657 23 25 23H18L12 28V23H7C5.343 23 4 21.657 4 20V8Z"
                  fill="#818cf8" opacity="0.35"
                />
              </svg>
            </div>
            <div>
              <p className="text-slate-400 text-sm font-medium">No messages yet</p>
              <p className="text-slate-600 text-xs mt-1">Be the first to say something 👋</p>
            </div>
          </div>

        ) : (
          /* Message list */
          <div className="max-w-3xl mx-auto flex flex-col">
            {grouped.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                own={isOwn(msg)}
                fmt={fmt}
              />
            ))}

            {/* Typing indicator — aligned with the left-side bubble content area */}
            {typingLabel && (
              <div className="flex items-center gap-2.5 mt-3">
                {/* Spacer matching the avatar column */}
                <div className="flex-none w-7" />
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1">
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce"
                      style={{ animationDelay: '0ms' }}
                    />
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce"
                      style={{ animationDelay: '150ms' }}
                    />
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce"
                      style={{ animationDelay: '300ms' }}
                    />
                  </div>
                  <span className="text-slate-500 text-xs">{typingLabel}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Invisible anchor — scrollIntoView targets this after each new message */}
        <div ref={bottomRef} />
      </main>

      {/* ── Input bar ───────────────────────────────────────────────────── */}
      <footer className="flex-none border-t border-[#1f2937] bg-[#0d1117]/90 backdrop-blur-sm px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-end gap-3">
          {/* Auto-sizing textarea wrapper */}
          <div className="flex-1 bg-[#111827] border border-[#1f2937] rounded-xl px-4 py-2.5 transition-colors focus-within:border-indigo-500/60 focus-within:ring-1 focus-within:ring-indigo-500/20">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              placeholder="Message Relay…"
              rows={1}
              className="w-full bg-transparent text-slate-200 placeholder:text-slate-600 text-sm resize-none outline-none leading-relaxed"
              style={{ maxHeight: '120px', overflowY: 'auto' }}
            />
          </div>

          {/* Send button */}
          <button
            onClick={sendMessage}
            disabled={!text.trim()}
            aria-label="Send message"
            className="flex-none w-10 h-10 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center transition-all duration-200 hover:scale-[1.05] active:scale-[0.95]"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>

        {/* Keyboard hint */}
        <p className="max-w-3xl mx-auto mt-1.5 text-[11px] text-slate-700 select-none">
          Enter to send · Shift+Enter for new line
        </p>
      </footer>
    </div>
  );
}

// ─── Message Bubble ────────────────────────────────────────────────────────────
// Hover timestamps: non-grouped bubbles already show a static timestamp.
// For grouped bubbles (no header), a timestamp is absolutely-positioned above
// the bubble and fades in on group hover — no layout shift.
function MessageBubble({ msg, own, fmt }) {
  if (own) {
    return (
      <div className={`flex flex-col items-end ${msg.isGrouped ? 'mt-0.5' : 'mt-4'} group`}>

        {/* Non-grouped: persistent timestamp above bubble */}
        {!msg.isGrouped && (
          <span className="text-[11px] text-slate-600 mb-1 mr-1">
            {fmt(msg.createdAt)}
          </span>
        )}

        {/* Bubble — relative so the hover-timestamp can anchor to it */}
        <div className="relative max-w-[70%] bg-indigo-600 text-white px-3.5 py-2 rounded-2xl rounded-tr-sm text-sm leading-relaxed break-words">
          {/* Grouped: hover-only timestamp floats above the bubble */}
          {msg.isGrouped && (
            <span className="absolute -top-5 right-0 text-[10px] text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity duration-150 whitespace-nowrap pointer-events-none">
              {fmt(msg.createdAt)}
            </span>
          )}
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-end gap-2.5 ${msg.isGrouped ? 'mt-0.5' : 'mt-4'} group`}>

      {/* Avatar — shown only on the first bubble of a group */}
      {!msg.isGrouped ? (
        <div className="flex-none w-7 h-7 rounded-full bg-slate-700 border border-slate-600/50 flex items-center justify-center text-slate-300 text-xs font-semibold select-none">
          {msg.username?.[0]?.toUpperCase()}
        </div>
      ) : (
        <div className="flex-none w-7" /> /* spacer keeps bubbles aligned */
      )}

      <div className="flex flex-col items-start max-w-[70%]">
        {/* Non-grouped: username + persistent timestamp */}
        {!msg.isGrouped && (
          <div className="flex items-baseline gap-2 mb-1 ml-0.5">
            <span className="text-xs font-semibold text-slate-300">{msg.username}</span>
            <span className="text-[11px] text-slate-600">{fmt(msg.createdAt)}</span>
          </div>
        )}

        {/* Bubble — relative so the hover-timestamp can anchor to it */}
        <div className="relative bg-[#1a2234] border border-[#252d3d] text-slate-200 px-3.5 py-2 rounded-2xl rounded-tl-sm text-sm leading-relaxed break-words">
          {/* Grouped: hover-only timestamp floats above the bubble */}
          {msg.isGrouped && (
            <span className="absolute -top-5 left-0 text-[10px] text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity duration-150 whitespace-nowrap pointer-events-none">
              {fmt(msg.createdAt)}
            </span>
          )}
          {msg.content}
        </div>
      </div>
    </div>
  );
}
