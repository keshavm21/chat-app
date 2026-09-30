import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { getErrorMessage } from '../../lib/errors';
import { searchPrefix } from '../../lib/names';

// Wait this long after the last keystroke before searching.
const SEARCH_DEBOUNCE_MS = 200;

/**
 * Searches `path` (GET /api/channels or /api/users) as `input` changes, and returns the
 * answer's `listKey` list. Text that no name could start with is not sent (lib/names.ts);
 * an answer to older text is dropped. While a search runs, the last results stay shown.
 */
export function useSearch(path, listKey, input) {
  const q = searchPrefix(input);
  const [answer, setAnswer] = useState({ q: undefined, results: [], error: '' });

  useEffect(() => {
    if (q === null) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.get(path, { params: { q } })
        .then(({ data }) => { if (!cancelled) setAnswer({ q, results: data[listKey], error: '' }); })
        .catch((err) => { if (!cancelled) setAnswer({ q, results: [], error: getErrorMessage(err, 'Search failed.') }); });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, listKey, q]);

  if (q === null) return { results: [], loading: false, error: '', searched: true };
  return { results: answer.results, loading: answer.q !== q, error: answer.q === q ? answer.error : '', searched: answer.q !== undefined };
}
