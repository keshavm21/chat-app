// client/src/socket.js
import { io } from 'socket.io-client';

// Connects to the page's own origin: Express serves the client in production, and Vite
// proxies /socket.io to the server in development (vite.config.js).
const socket = io({
  // Don't auto-connect — Chat.jsx calls socket.connect() on mount and
  // socket.disconnect() on unmount so the lifecycle is explicit.
  autoConnect: false,

  // WebSocket only, which the server requires: a WebSocket handshake always carries the
  // Origin header that the server checks, while a same-origin HTTP long-polling one does not.
  // The handshake also carries the httpOnly session cookie, checked on every connection
  // attempt, so a logout → login cycle works without recreating the socket.
  transports: ['websocket'],
});

export default socket;
