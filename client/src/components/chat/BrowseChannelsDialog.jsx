import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../context/useChat';
import { getErrorMessage } from '../../lib/errors';
import Dialog, { FormError, inputClass } from './Dialog';
import { HashIcon } from './icons';
import { useSearch } from './useSearch';

/** Finds public channels by name, and joins or opens one. */
export default function BrowseChannelsDialog({ onClose, onNewChannel }) {
  const { joinChannel } = useChat();
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [joining, setJoining] = useState(null);
  const [error, setError] = useState('');
  const { results, loading, error: searchError, searched } = useSearch('/api/channels', 'channels', input);

  const open = async (channel) => {
    setError('');
    if (!channel.isMember) {
      setJoining(channel.id);
      try {
        await joinChannel(channel.id);
      } catch (err) {
        setJoining(null);
        setError(getErrorMessage(err, 'Could not join the channel.'));
        return;
      }
    }
    onClose();
    navigate(`/c/${channel.id}`);
  };

  return (
    <Dialog title="Browse channels" onClose={onClose} wide>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Search channels by name"
        aria-label="Search channels"
        className={inputClass}
      />
      <ul className="mt-3 max-h-80 overflow-y-auto -mx-1" aria-busy={loading}>
        {results.map((channel) => (
          <li key={channel.id}>
            <button
              onClick={() => open(channel)}
              disabled={joining !== null}
              className="w-full text-left px-2 py-2 rounded-lg hover:bg-white/5 flex items-center gap-3 disabled:opacity-60"
            >
              <span className="flex-none text-slate-500"><HashIcon /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-slate-200 truncate">{channel.name}</span>
                {channel.topic && <span className="block text-xs text-slate-500 truncate">{channel.topic}</span>}
              </span>
              <span
                className={`flex-none text-xs font-medium px-2.5 py-1 rounded-lg ${
                  channel.isMember ? 'text-slate-500' : 'text-indigo-300 bg-indigo-600/15 border border-indigo-500/30'
                }`}
              >
                {joining === channel.id ? 'Joining…' : channel.isMember ? 'Joined' : 'Join'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {searched && !loading && results.length === 0 && !searchError && (
        <p className="mt-2 text-sm text-slate-500">
          No channel starts with that.{' '}
          <button onClick={onNewChannel} className="text-indigo-300 hover:text-indigo-200">Create one</button>
        </p>
      )}
      <FormError message={searchError || error} />
    </Dialog>
  );
}
