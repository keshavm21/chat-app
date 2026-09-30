import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthProvider';
import ProtectedRoute from './components/ProtectedRoute';
import GuestRoute from './components/GuestRoute';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Chat from './pages/Chat';
import ChatHome from './pages/ChatHome';
import Conversation from './pages/Conversation';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Landing />} />

          {/* GuestRoute: redirect to /chat if already logged in */}
          <Route path="/login"  element={<GuestRoute><Login /></GuestRoute>} />
          <Route path="/signup" element={<GuestRoute><Signup /></GuestRoute>} />

          {/* ProtectedRoute: redirect to /login if not logged in. The chat layout (the
              socket, the sidebar) stays mounted while the conversation changes. */}
          <Route element={<ProtectedRoute><Chat /></ProtectedRoute>}>
            <Route path="/chat" element={<ChatHome />} />
            <Route path="/c/:conversationId" element={<Conversation />} />
          </Route>

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}