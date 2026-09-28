import axios from 'axios';

// Requests go to the page's own origin: Express serves the client in production, and
// Vite proxies /api to the server in development (vite.config.js). Same-origin requests
// carry the httpOnly session cookie by themselves.
const api = axios.create();

export default api;
