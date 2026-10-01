import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';

// Wraps /login and /signup.
// Renders nothing until the session check answers; if already logged in → /chat.
export default function GuestRoute({ children }) {
  const { status } = useAuth();
  if (status === 'loading') return null;
  return status === 'authenticated' ? <Navigate to="/chat" replace /> : children;
}
