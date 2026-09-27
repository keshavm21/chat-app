import { useContext } from 'react';
import { AuthContext } from './authContext';

// Custom hook — throw a clear error if used outside AuthProvider
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
