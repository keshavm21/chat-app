// Server error bodies are { error: { code, message } }. Older servers sent
// { error: "message" }; both are accepted so the client works during deploys.

/** The server's error message from a failed request, or `fallback` if there is none (e.g. network error). */
export function getErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (!data || typeof data !== 'object' || !('error' in data)) return fallback;

  const { error } = data;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}
