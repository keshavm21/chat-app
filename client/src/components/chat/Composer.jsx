import { useRef, useState } from 'react';
import { SendIcon } from './icons';

// The tallest the message box grows before it scrolls.
const MAX_HEIGHT_PX = 120;

/**
 * Writes a message in one conversation (keyed by it, so a draft stays with its
 * conversation's view). Enter sends, Shift+Enter starts a new line. While the socket is
 * down, nothing is sent and the text stays.
 */
export default function Composer({ conversation, connected, onSend, onTyping }) {
  const [text, setText] = useState('');
  const textareaRef = useRef(null);

  const resize = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_HEIGHT_PX)}px`;
  };

  const send = () => {
    const content = text.trim();
    if (!content || !onSend(content)) return;
    setText('');
    requestAnimationFrame(resize);
  };

  const placeholder = conversation.type === 'dm' ? `Message ${conversation.name}` : `Message #${conversation.name}`;

  return (
    <footer className="flex-none border-t border-[#1f2937] bg-[#0d1117]/90 backdrop-blur-sm px-4 py-3">
      <div className="max-w-3xl mx-auto flex items-end gap-3">
        <div className="flex-1 bg-[#111827] border border-[#1f2937] rounded-xl px-4 py-2.5 transition-colors focus-within:border-indigo-500/60 focus-within:ring-1 focus-within:ring-indigo-500/20">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              resize();
              if (e.target.value.trim()) onTyping();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            rows={1}
            className="w-full bg-transparent text-slate-200 placeholder:text-slate-600 text-sm resize-none outline-none leading-relaxed"
            style={{ maxHeight: `${MAX_HEIGHT_PX}px`, overflowY: 'auto' }}
          />
        </div>
        <button
          onClick={send}
          disabled={!text.trim() || !connected}
          aria-label="Send message"
          className="flex-none w-10 h-10 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center transition-all duration-200 hover:scale-[1.05] active:scale-[0.95]"
        >
          <SendIcon />
        </button>
      </div>
      <p className="max-w-3xl mx-auto mt-1.5 text-[11px] text-slate-700 select-none">
        {connected ? 'Enter to send · Shift+Enter for new line' : 'Reconnecting… your message will wait here.'}
      </p>
    </footer>
  );
}
