import { useCallback, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { ChatProvider } from '../context/ChatProvider';
import { useChat } from '../context/useChat';
import AddPeopleDialog from '../components/chat/AddPeopleDialog';
import BrowseChannelsDialog from '../components/chat/BrowseChannelsDialog';
import LeaveDialog from '../components/chat/LeaveDialog';
import NewChannelDialog from '../components/chat/NewChannelDialog';
import NewMessageDialog from '../components/chat/NewMessageDialog';
import Sidebar from '../components/chat/Sidebar';
import Toasts from '../components/chat/Toasts';

/**
 * The chat's layout, for /chat and /c/:conversationId (App.jsx): the chat state and the
 * socket (ChatProvider), the sidebar (a drawer on narrow screens), the dialogs, and the
 * page in <Outlet />. Switching conversations keeps all of it, the socket included.
 */
export default function Chat() {
  return (
    <ChatProvider>
      <ChatLayout />
    </ChatProvider>
  );
}

function ChatLayout() {
  const { toasts } = useChat();
  // The open dialog: { type: 'browse' | 'newChannel' | 'newMessage' | 'addPeople' | 'leave', conversation? }
  const [dialog, setDialog] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const closeDialog = useCallback(() => setDialog(null), []);
  const openDialog = useCallback((next) => {
    setDrawerOpen(false);
    setDialog(next);
  }, []);
  const openSidebar = useCallback(() => setDrawerOpen(true), []);

  const sidebar = (
    <Sidebar
      onBrowseChannels={() => openDialog({ type: 'browse' })}
      onNewChannel={() => openDialog({ type: 'newChannel' })}
      onNewMessage={() => openDialog({ type: 'newMessage' })}
      onNavigate={() => setDrawerOpen(false)}
    />
  );

  return (
    <div className="h-dvh bg-[#0a0b14] flex overflow-hidden">
      <Toasts toasts={toasts} />

      <div className="hidden md:flex flex-none">{sidebar}</div>
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
          <div className="relative h-full fade-in-up">{sidebar}</div>
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <Outlet context={{ openDialog, openSidebar }} />
      </div>

      {dialog?.type === 'browse' && (
        <BrowseChannelsDialog onClose={closeDialog} onNewChannel={() => openDialog({ type: 'newChannel' })} />
      )}
      {dialog?.type === 'newChannel' && <NewChannelDialog onClose={closeDialog} />}
      {dialog?.type === 'newMessage' && <NewMessageDialog onClose={closeDialog} />}
      {dialog?.type === 'addPeople' && <AddPeopleDialog conversation={dialog.conversation} onClose={closeDialog} />}
      {dialog?.type === 'leave' && <LeaveDialog conversation={dialog.conversation} onClose={closeDialog} />}
    </div>
  );
}
