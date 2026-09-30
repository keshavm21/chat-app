import { useState } from 'react';
import { useChat } from '../../context/useChat';
import { getErrorMessage } from '../../lib/errors';
import Dialog, { FormError, inputClass, primaryButtonClass, secondaryButtonClass } from './Dialog';

/** The owner of a private channel adds someone by username. */
export default function AddPeopleDialog({ conversation, onClose }) {
  const { addMember } = useChat();
  const [username, setUsername] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [added, setAdded] = useState([]);

  const submit = async (e) => {
    e.preventDefault();
    const name = username.trim().replace(/^@/, '').toLowerCase();
    setSaving(true);
    setError('');
    try {
      await addMember(conversation.id, name);
      setAdded((prev) => (prev.includes(name) ? prev : [...prev, name]));
      setUsername('');
    } catch (err) {
      setError(getErrorMessage(err, 'Could not add them.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={`Add people to ${conversation.name}`} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Their username"
          aria-label="Username"
          className={inputClass}
        />
        {added.length > 0 && (
          <p className="text-sm text-emerald-400" role="status">Added: {added.join(', ')}</p>
        )}
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>Done</button>
          <button type="submit" disabled={!username.trim() || saving} className={primaryButtonClass}>
            {saving ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
