import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';

// Wraps /login and /signup.
// If already logged in → skip those pages and go straight to /chat.
export default function GuestRoute({ children }) {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <Navigate to="/chat" replace /> : children;
}