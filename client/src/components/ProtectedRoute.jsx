import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';

// Wraps any route that requires a logged-in user.
// Renders nothing until the session check answers; without a session → /login.
export default function ProtectedRoute({ children }) {
  const { status } = useAuth();
  if (status === 'loading') return null;
  return status === 'authenticated' ? children : <Navigate to="/login" replace />;
}
