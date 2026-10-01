import { useState } from 'react';
import { useChat } from '../../context/useChat';
import { getErrorMessage } from '../../lib/errors';
import Dialog, { FormError, secondaryButtonClass } from './Dialog';

/** Asks before leaving a channel; a private one can only be rejoined if its owner adds me. */
export default function LeaveDialog({ conversation, onClose }) {
  const { leaveConversation } = useChat();
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');

  const leave = async () => {
    setLeaving(true);
    setError('');
    try {
      await leaveConversation(conversation.id);
      onClose();
    } catch (err) {
      setLeaving(false);
      setError(getErrorMessage(err, 'Could not leave the channel.'));
    }
  };

  return (
    <Dialog title={`Leave ${conversation.name}?`} onClose={onClose}>
      <p className="text-sm text-slate-400">
        {conversation.visibility === 'private'
          ? 'You will lose access to its messages. Only its owner can add you back.'
          : 'You can join it again from Browse channels.'}
      </p>
      <FormError message={error} />
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className={secondaryButtonClass}>Cancel</button>
        <button
          onClick={leave}
          disabled={leaving}
          className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-sm font-medium transition-colors"
        >
          {leaving ? 'Leaving…' : 'Leave'}
        </button>
      </div>
    </Dialog>
  );
}
