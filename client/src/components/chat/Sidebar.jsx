import { NavLink } from 'react-router-dom';
import { useAuth } from '../../context/useAuth';
import { useChat } from '../../context/useChat';
import { Avatar, ConversationMark, Logo, PlusIcon, SearchIcon } from './icons';

/**
 * My conversations, channels then DMs, each list most recently active first, with unread
 * badges; the actions that start new ones; and my account. On narrow screens it is a
 * drawer the conversation header opens (pages/Chat.jsx).
 */
export default function Sidebar({ onBrowseChannels, onNewChannel, onNewMessage, onNavigate }) {
  const { user, logout } = useAuth();
  const { conversations, listStatus, onlineCount, connected } = useChat();
  const channels = conversations.filter((c) => c.type === 'channel');
  const dms = conversations.filter((c) => c.type === 'dm');

  return (
    <nav aria-label="Conversations" className="h-full w-72 md:w-64 flex flex-col bg-[#0d1117] border-r border-[#1f2937]">
      {/* Brand + who is online */}
      <div className="flex-none h-14 px-4 flex items-center justify-between border-b border-[#1f2937]">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="font-bold text-white text-[15px]" style={{ fontFamily: 'Syne, sans-serif' }}>Relay</span>
        </div>
        <div className="flex items-center gap-1.5" title={connected ? 'Connected' : 'Reconnecting…'}>
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
          <span className="text-slate-400 text-xs">
            {connected ? `${onlineCount} online` : 'Offline'}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-3">
        <Section
          title="Channels"
          actions={[
            { label: 'Browse channels', icon: <SearchIcon size={14} />, onClick: onBrowseChannels },
            { label: 'New channel', icon: <PlusIcon size={14} />, onClick: onNewChannel },
          ]}
        >
          {channels.map((c) => <ConversationLink key={c.id} conversation={c} onNavigate={onNavigate} />)}
        </Section>

        <Section title="Direct messages" actions={[{ label: 'New message', icon: <PlusIcon size={14} />, onClick: onNewMessage }]}>
          {dms.map((c) => <ConversationLink key={c.id} conversation={c} onNavigate={onNavigate} />)}
          {listStatus === 'ready' && dms.length === 0 && (
            <button onClick={onNewMessage} className="w-full text-left px-4 py-1.5 text-xs text-slate-600 hover:text-slate-400">
              Start a conversation…
            </button>
          )}
        </Section>

        {listStatus === 'loading' && <p className="px-4 py-2 text-xs text-slate-600">Loading…</p>}
        {listStatus === 'error' && <p className="px-4 py-2 text-xs text-red-400">Could not load your conversations.</p>}
      </div>

      {/* Me */}
      <div className="flex-none px-4 py-3 border-t border-[#1f2937] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Avatar name={user?.username} />
          <span className="text-slate-300 text-sm truncate">{user?.username}</span>
        </div>
        <button
          onClick={logout}
          className="flex-none text-slate-500 hover:text-slate-300 text-xs font-medium transition-colors px-2.5 py-1.5 rounded-lg hover:bg-white/5 border border-transparent hover:border-white/10"
        >
          Sign out
        </button>
      </div>
    </nav>
  );
}

function Section({ title, actions, children }) {
  return (
    <section className="mb-4">
      <div className="px-4 mb-1 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500" style={{ fontFamily: 'inherit' }}>
          {title}
        </h3>
        <div className="flex items-center gap-0.5">
          {actions.map((action) => (
            <button
              key={action.label}
              onClick={action.onClick}
              aria-label={action.label}
              title={action.label}
              className="p-1 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors"
            >
              {action.icon}
            </button>
          ))}
        </div>
      </div>
      <ul>{children}</ul>
    </section>
  );
}

function ConversationLink({ conversation, onNavigate }) {
  const unread = conversation.unreadCount;
  return (
    <li>
      <NavLink
        to={`/c/${conversation.id}`}
        onClick={onNavigate}
        className={({ isActive }) =>
          `mx-2 px-2 py-1.5 rounded-lg flex items-center gap-2 text-sm transition-colors ${
            isActive ? 'bg-indigo-600/20 text-white' : unread > 0 ? 'text-white hover:bg-white/5' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
          }`
        }
      >
        {({ isActive }) => (
          <>
            <span className="flex-none w-5 flex justify-center text-slate-500"><ConversationMark conversation={conversation} /></span>
            <span className={`flex-1 truncate ${unread > 0 && !isActive ? 'font-semibold' : ''}`}>{conversation.name}</span>
            {/* The open conversation is being read: no badge. */}
            {unread > 0 && !isActive && (
              <span
                aria-label={`${unread} unread`}
                data-testid="unread-badge"
                className="flex-none min-w-5 h-5 px-1.5 rounded-full bg-indigo-600 text-white text-[11px] font-semibold flex items-center justify-center"
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </>
        )}
      </NavLink>
    </li>
  );
}
