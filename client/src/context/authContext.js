import { createContext } from 'react';

// Kept in its own file so AuthProvider.jsx exports only a component,
// which Vite's fast refresh requires.
export const AuthContext = createContext(null);
