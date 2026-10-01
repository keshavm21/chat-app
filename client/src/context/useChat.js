import { useContext } from 'react';
import { ChatContext } from './chatContext';

// The chat's state and actions (ChatProvider.jsx); throws outside the chat pages.
export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used inside <ChatProvider>');
  return ctx;
}
