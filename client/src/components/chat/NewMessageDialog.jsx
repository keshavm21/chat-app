import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../context/useChat';
import { getErrorMessage } from '../../lib/errors';
import Dialog, { FormError, inputClass } from './Dialog';
import { Avatar } from './icons';
import { useSearch } from './useSearch';

/** Finds a user by username and opens our DM, creating it the first time. */
export default function NewMessageDialog({ onClose }) {
  const { openDm } = useChat();
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [opening, setOpening] = useState(null);
  const [error, setError] = useState('');
  const { results, loading, error: searchError, searched } = useSearch('/api/users', 'users', input);

  const open = async (user) => {
    setOpening(user.id);
    setError('');
    try {
      const dm = await openDm(user.id);
      onClose();
      navigate(`/c/${dm.id}`);
    } catch (err) {
      setOpening(null);
      setError(getErrorMessage(err, 'Could not open the conversation.'));
    }
  };

  return (
    <Dialog title="New message" onClose={onClose}>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Find someone by username"
        aria-label="Find someone by username"
        className={inputClass}
      />
      <ul className="mt-3 max-h-72 overflow-y-auto -mx-1" aria-busy={loading}>
        {results.map((user) => (
          <li key={user.id}>
            <button
              onClick={() => open(user)}
              disabled={opening !== null}
              className="w-full text-left px-2 py-2 rounded-lg hover:bg-white/5 flex items-center gap-3 disabled:opacity-60"
            >
              <Avatar name={user.username} />
              <span className="flex-1 text-sm text-slate-200 truncate">{user.username}</span>
              {opening === user.id && <span className="text-xs text-slate-500">Opening…</span>}
            </button>
          </li>
        ))}
      </ul>
      {searched && !loading && results.length === 0 && !searchError && (
        <p className="mt-2 text-sm text-slate-500">No one else has a username that starts with that.</p>
      )}
      <FormError message={searchError || error} />
    </Dialog>
  );
}
