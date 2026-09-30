import { useEffect } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import { useChat } from '../context/useChat';
import { lastConversationKey } from '../lib/chatState';
import Composer from '../components/chat/Composer';
import ConversationHeader from '../components/chat/ConversationHeader';
import MessageList from '../components/chat/MessageList';
import { MenuIcon, Spinner } from '../components/chat/icons';

/** /c/:conversationId — one conversation: its header, messages and composer. */
export default function Conversation() {
  const { conversationId } = useParams();
  const id = Number(conversationId);
  const { user } = useAuth();
  const { conversations, listStatus, timelines, typing, connected, loadLatest, loadOlder, sendMessage, sendTyping } = useChat();
  const { openDialog, openSidebar } = useOutletContext();

  const conversation = conversations.find((c) => c.id === id);
  const timeline = timelines[id];
  const known = !!conversation;
  const loaded = !!timeline;

  // Its history loads the first time it is opened (live messages keep it current after).
  useEffect(() => {
    if (known && !loaded) loadLatest(id);
  }, [id, known, loaded, loadLatest]);

  // /chat reopens it next time.
  useEffect(() => {
    if (!known) return;
    try {
      localStorage.setItem(lastConversationKey(user.id), String(id));
    } catch {
      // Storage can be unavailable (a private window); /chat then opens #general.
    }
  }, [id, known, user.id]);

  const title = conversation ? (conversation.type === 'dm' ? conversation.name : `#${conversation.name}`) : null;
  useEffect(() => {
    if (!title) return undefined;
    document.title = `${title} · Relay`;
    return () => { document.title = 'Relay'; };
  }, [title]);

  if (!conversation) {
    return (
      <Placeholder onOpenSidebar={openSidebar}>
        {listStatus === 'loading' ? (
          <span className="flex items-center gap-2"><Spinner /> Loading…</span>
        ) : listStatus === 'error' ? (
          'Could not load your conversations.'
        ) : (
          <span className="text-center">
            This conversation does not exist, or you are not in it.{' '}
            <Link to="/chat" className="text-indigo-300 hover:text-indigo-200">Go to your conversations</Link>
          </span>
        )}
      </Placeholder>
    );
  }

  return (
    <>
      <ConversationHeader
        conversation={conversation}
        onOpenSidebar={openSidebar}
        onAddPeople={() => openDialog({ type: 'addPeople', conversation })}
        onLeave={() => openDialog({ type: 'leave', conversation })}
      />
      {timeline?.status === 'error' ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-3">
            Could not load messages.
            <button onClick={() => loadLatest(id)} className="text-red-300 underline">Try again</button>
          </div>
        </div>
      ) : (
        <MessageList
          key={`messages-${id}`}
          timeline={timeline ?? { messages: [], status: 'loading', loadingOlder: false }}
          myUserId={user.id}
          typingNames={(typing[id] ?? []).filter((name) => name !== user.username)}
          onLoadOlder={() => loadOlder(id)}
        />
      )}
      <Composer
        key={`composer-${id}`}
        conversation={conversation}
        connected={connected}
        onSend={(content) => sendMessage(id, content)}
        onTyping={() => sendTyping(id)}
      />
    </>
  );
}

/** What the main area shows without a conversation: a message, and the menu on narrow screens. */
export function Placeholder({ onOpenSidebar, children }) {
  return (
    <>
      <header className="md:hidden flex-none h-14 border-b border-[#1f2937] flex items-center px-4">
        <button onClick={onOpenSidebar} aria-label="Open conversations" className="p-1.5 -ml-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/5">
          <MenuIcon />
        </button>
      </header>
      <div className="flex-1 flex items-center justify-center px-6 text-slate-500 text-sm">{children}</div>
    </>
  );
}
