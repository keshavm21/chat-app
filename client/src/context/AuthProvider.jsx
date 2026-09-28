import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import { AuthContext } from './authContext';

// Where the JWT and the user used to be kept; removed from browsers that still have them.
const LEGACY_STORAGE_KEYS = ['relay_token', 'relay_user'];

const GUEST = { status: 'guest', user: null };

export function AuthProvider({ children }) {
  // The session cookie is httpOnly, so only the server knows whether this browser is
  // logged in: the status is 'loading' until GET /api/auth/me answers.
  const [auth, setAuth] = useState({ status: 'loading', user: null });

  useEffect(() => {
    // A request that finds the session gone (401 UNAUTHENTICATED) logs out locally, and
    // the routes redirect to /login. A wrong password (401 INVALID_CREDENTIALS) is not affected.
    const interceptor = api.interceptors.response.use(undefined, (err) => {
      if (err.response?.status === 401 && err.response.data?.error?.code === 'UNAUTHENTICATED') {
        setAuth(GUEST);
      }
      return Promise.reject(err);
    });

    for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);

    let cancelled = false;
    api.get('/api/auth/me')
      .then(({ data }) => { if (!cancelled) setAuth({ status: 'authenticated', user: data.user }); })
      .catch(() => { if (!cancelled) setAuth(GUEST); });

    return () => {
      cancelled = true;
      api.interceptors.response.eject(interceptor);
    };
  }, []);

  // Takes the user from the signup or login response, which also set the session cookie.
  const login = useCallback((user) => setAuth({ status: 'authenticated', user }), []);

  const logout = useCallback(async () => {
    try {
      // A JSON body, like every state-changing request: the server refuses others (415).
      await api.post('/api/auth/logout', {});
    } catch {
      // Log out locally even if the request fails (e.g. offline).
    }
    setAuth(GUEST);
  }, []);

  const value = useMemo(() => ({ ...auth, login, logout }), [auth, login, logout]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
