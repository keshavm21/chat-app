import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../context/useChat';
import { getErrorMessage } from '../../lib/errors';
import { toChannelName } from '../../lib/names';
import Dialog, { FormError, inputClass, primaryButtonClass, secondaryButtonClass } from './Dialog';

// The server's limit (server/lib/limits.ts, CHANNEL_TOPIC_MAX_LENGTH).
const TOPIC_MAX_LENGTH = 250;

/** Creates a public or private channel, and opens it. */
export default function NewChannelDialog({ onClose }) {
  const { createChannel } = useChat();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const channel = await createChannel({ name, topic: topic.trim() || null, visibility: isPrivate ? 'private' : 'public' });
      onClose();
      navigate(`/c/${channel.id}`);
    } catch (err) {
      setSaving(false);
      setError(getErrorMessage(err, 'Could not create the channel.'));
    }
  };

  return (
    <Dialog title="New channel" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-400">Name</span>
          <input
            value={name}
            onChange={(e) => setName(toChannelName(e.target.value))}
            placeholder="e.g. weekend-plans"
            className={inputClass}
            required
          />
          <span className="text-[11px] text-slate-600">Lowercase letters, digits and hyphens, up to 40.</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-400">Topic <span className="text-slate-600">(optional)</span></span>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={TOPIC_MAX_LENGTH} placeholder="What is it about?" className={inputClass} />
        </label>
        <label className="flex items-start gap-2.5 mt-1 cursor-pointer">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} className="mt-0.5 accent-indigo-500" />
          <span>
            <span className="block text-sm text-slate-200">Private</span>
            <span className="block text-xs text-slate-500">Only people you add can see it or find it.</span>
          </span>
        </label>
        <FormError message={error} />
        <div className="flex justify-end gap-2 mt-2">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>Cancel</button>
          <button type="submit" disabled={!name || saving} className={primaryButtonClass}>
            {saving ? 'Creating…' : 'Create channel'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
