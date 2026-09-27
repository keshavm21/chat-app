import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5001',
  // Sends the httpOnly session cookie. The API is on another origin (in development,
  // another port), so the browser only sends cookies when asked to.
  withCredentials: true,
});

export default api;
