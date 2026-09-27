import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5001',
});

// Automatically attach the JWT to every request.
// This is exactly what you'll describe in interviews.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('relay_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default api;