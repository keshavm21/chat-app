import { canLeave } from '../../lib/chatState';
import { ConversationMark, MenuIcon } from './icons';

/**
 * The open conversation's name and topic, and what I can do in it: add people (a private
 * channel's owner) and leave. On narrow screens it also opens the sidebar.
 */
export default function ConversationHeader({ conversation, onOpenSidebar, onAddPeople, onLeave }) {
  const isOwnerOfPrivate = conversation.visibility === 'private' && conversation.role === 'owner';
  return (
    <header className="flex-none h-14 border-b border-[#1f2937] bg-[#0d1117]/90 backdrop-blur-sm flex items-center gap-3 px-4">
      <button
        onClick={onOpenSidebar}
        aria-label="Open conversations"
        className="md:hidden p-1.5 -ml-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/5"
      >
        <MenuIcon />
      </button>

      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className="flex-none text-slate-500"><ConversationMark conversation={conversation} /></span>
        <div className="min-w-0">
          <h1 className="text-white text-[15px] font-semibold truncate" style={{ fontFamily: 'inherit' }}>
            {conversation.name}
          </h1>
          {conversation.topic && <p className="text-slate-500 text-xs truncate">{conversation.topic}</p>}
        </div>
      </div>

      <div className="flex-none flex items-center gap-1">
        {isOwnerOfPrivate && (
          <button onClick={onAddPeople} className="text-slate-400 hover:text-slate-200 text-xs font-medium px-2.5 py-1.5 rounded-lg hover:bg-white/5">
            Add people
          </button>
        )}
        {canLeave(conversation) && (
          <button onClick={onLeave} className="text-slate-500 hover:text-red-300 text-xs font-medium px-2.5 py-1.5 rounded-lg hover:bg-white/5">
            Leave
          </button>
        )}
      </div>
    </header>
  );
}
