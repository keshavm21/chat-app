import { Navigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import { useChat } from '../context/useChat';
import { findGeneral, lastConversationKey } from '../lib/chatState';
import { Spinner } from '../components/chat/icons';
import { Placeholder } from './Conversation';

function lastConversationId(userId) {
  try {
    return Number(localStorage.getItem(lastConversationKey(userId)));
  } catch {
    return null;
  }
}

/** /chat — opens the conversation I last had open, or #general. */
export default function ChatHome() {
  const { user } = useAuth();
  const { conversations, listStatus } = useChat();
  const { openSidebar } = useOutletContext();

  if (listStatus === 'ready') {
    const last = lastConversationId(user.id);
    const target = conversations.find((c) => c.id === last) ?? findGeneral(conversations) ?? conversations[0];
    if (target) return <Navigate to={`/c/${target.id}`} replace />;
  }

  return (
    <Placeholder onOpenSidebar={openSidebar}>
      {listStatus === 'loading' ? (
        <span className="flex items-center gap-2"><Spinner /> Loading…</span>
      ) : listStatus === 'error' ? (
        'Could not load your conversations.'
      ) : (
        'No conversations yet: browse channels or start a new message.'
      )}
    </Placeholder>
  );
}
