import { createContext } from 'react';

// Kept in its own file so ChatProvider.jsx exports only a component,
// which Vite's fast refresh requires.
export const ChatContext = createContext(null);
