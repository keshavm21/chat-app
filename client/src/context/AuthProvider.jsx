import { useState } from 'react';
import { AuthContext } from './authContext';

export function AuthProvider({ children }) {
  // Initialise from localStorage so auth survives page refreshes.
  // Note: localStorage is fine for a portfolio project. In production you'd
  // use httpOnly cookies to prevent XSS access to the token.
  const [token, setToken] = useState(() => localStorage.getItem('relay_token') || null);
  const [user, setUser] = useState(() => {
    try {
      const stored = localStorage.getItem('relay_user');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const login = (tokenValue, userData) => {
    localStorage.setItem('relay_token', tokenValue);
    localStorage.setItem('relay_user', JSON.stringify(userData));
    setToken(tokenValue);
    setUser(userData);
  };

  const logout = () => {
    localStorage.removeItem('relay_token');
    localStorage.removeItem('relay_user');
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}