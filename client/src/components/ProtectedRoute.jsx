import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';

// Wraps any route that requires a logged-in user.
// If no token → redirect to /login.
export default function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}