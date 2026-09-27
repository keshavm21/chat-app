// client/src/socket.js
import { io } from 'socket.io-client';

// Matches VITE_API_URL in your .env (or falls back to the local dev port).
const URL = import.meta.env.VITE_API_URL || 'http://localhost:5001';

const socket = io(URL, {
  // Don't auto-connect — Chat.jsx calls socket.connect() on mount and
  // socket.disconnect() on unmount so the lifecycle is explicit.
  autoConnect: false,

  // The handshake carries the httpOnly session cookie, which the server checks on
  // every connection attempt, so a logout → login cycle works without recreating the socket.
  withCredentials: true,
});

export default socket;
