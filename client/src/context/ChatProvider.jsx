import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import api from '../api/axios';
import socket from '../socket';
import {
  applyMessage,
  markReadLocally,
  removeConversation,
  sortConversations,
  timelinesReducer,
  upsertConversation,
} from '../lib/chatState';
import { createHandshakeRetry, isAuthenticationError } from '../lib/reconnect';
import { useAuth } from './useAuth';
import { ChatContext } from './chatContext';

// How often the composer tells the server "still typing" at most. The server clears the
// indicator 3 s after the last one (socketHandler.js), so once a second keeps it on.
const TYPING_EVERY_MS = 1000;

// How long a toast stays.
const TOAST_MS = 4000;

/**
 * The chat's state, for the pages under /chat and /c/:conversationId: the sidebar's
 * conversations (GET /api/conversations, then kept current by socket events), each
 * conversation's messages (a reducer keyed by conversation: lib/chatState.ts), who is
 * typing where, the online count, and the socket's lifecycle. Pure rules live in
 * lib/chatState.ts; this wires them to the API and the socket.
 */
export function ChatProvider({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const match = useMatch('/c/:conversationId');
  const openId = match ? Number(match.params.conversationId) || null : null;

  const [conversations, setConversations] = useState([]);
  const [listStatus, setListStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [timelines, dispatch] = useReducer(timelinesReducer, {});
  const [typing, setTyping] = useState({}); // conversationId → usernames
  const [onlineCount, setOnlineCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');

  // What the socket's listeners (registered once) need to read.
  const openIdRef = useRef(openId);
  const userIdRef = useRef(user.id);
  const timelinesRef = useRef(timelines);
  useEffect(() => {
    openIdRef.current = openId;
    userIdRef.current = user.id;
    timelinesRef.current = timelines;
  });

  const notify = useCallback((message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_MS);
  }, []);

  // ── The conversation list ──────────────────────────────────────────────────
  // Every change to the list goes through changeList(). While the list is being fetched,
  // changes are also kept aside and applied again to the response, which may have been
  // read before them (a DM opened, a message arriving): the fetch never undoes them.
  const fetchRef = useRef({ generation: 0, inFlight: false, pending: [] });

  const changeList = useCallback((change) => {
    setConversations(change);
    if (fetchRef.current.inFlight) fetchRef.current.pending.push(change);
  }, []);

  const loadConversations = useCallback(async () => {
    const fetch = fetchRef.current;
    const generation = ++fetch.generation;
    fetch.inFlight = true;
    fetch.pending = [];
    try {
      const { data } = await api.get('/api/conversations');
      if (generation !== fetch.generation) return; // a newer fetch is on its way
      let list = sortConversations(data.conversations);
      for (const change of fetch.pending) list = change(list);
      setConversations(list);
      setListStatus('ready');
    } catch {
      if (generation !== fetch.generation) return;
      setListStatus((status) => (status === 'ready' ? status : 'error'));
    } finally {
      if (generation === fetch.generation) {
        fetch.inFlight = false;
        fetch.pending = [];
      }
    }
  }, []);

  // ── Timelines ──────────────────────────────────────────────────────────────
  const loadLatest = useCallback(async (conversationId) => {
    dispatch({ type: 'loading', conversationId });
    try {
      const { data } = await api.get(`/api/conversations/${conversationId}/messages`);
      dispatch({ type: 'latestLoaded', conversationId, messages: data.messages });
    } catch {
      dispatch({ type: 'failed', conversationId });
    }
  }, []);

  const loadOlder = useCallback(async (conversationId) => {
    const timeline = timelinesRef.current[conversationId];
    const oldest = timeline?.messages[0];
    if (!oldest || oldest.seq <= 1 || timeline.loadingOlder) return;
    dispatch({ type: 'loadingOlder', conversationId });
    try {
      const { data } = await api.get(`/api/conversations/${conversationId}/messages`, { params: { before: oldest.seq } });
      dispatch({ type: 'olderLoaded', conversationId, messages: data.messages });
    } catch {
      dispatch({ type: 'olderFailed', conversationId });
      notify('Could not load older messages.');
    }
  }, [notify]);

  // ── Reading ────────────────────────────────────────────────────────────────
  // The server moves my read position forward only; the sidebar's count follows once it
  // has (the open conversation shows no badge meanwhile: Sidebar.jsx).
  const readSentRef = useRef({});
  const markRead = useCallback((conversationId, seq) => {
    if ((readSentRef.current[conversationId] ?? 0) >= seq) return;
    readSentRef.current[conversationId] = seq;
    api.put(`/api/conversations/${conversationId}/read`, { seq })
      .then(() => changeList((list) => markReadLocally(list, conversationId, seq)))
      .catch(() => {
        delete readSentRef.current[conversationId]; // try again with the next message
      });
  }, [changeList]);

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // The open conversation, while the tab is visible, is read up to its latest message.
  const open = conversations.find((c) => c.id === openId);
  const openUnread = open?.unreadCount ?? 0;
  const openLastSeq = open?.lastSeq ?? 0;
  useEffect(() => {
    if (openId && visible && openUnread > 0) markRead(openId, openLastSeq);
  }, [openId, visible, openUnread, openLastSeq, markRead]);

  // ── Socket ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true; // false once this effect is cleaned up
    // Retries handshakes the server refused without ending the session (lib/reconnect.ts).
    const handshakeRetry = createHandshakeRetry(() => {
      if (active && !socket.connected) socket.connect();
    });

    const removeTypist = (conversationId, username) =>
      setTyping((prev) => {
        if (!prev[conversationId]?.includes(username)) return prev;
        return { ...prev, [conversationId]: prev[conversationId].filter((u) => u !== username) };
      });

    // On every connect, the first and each reconnect, the sidebar and the open
    // conversation catch up on what they missed; other cached timelines may have missed
    // messages too, so they load again when opened (docs/v2-design.md §5, simplified level).
    socket.on('connect', () => {
      handshakeRetry.reset();
      setConnected(true);
      setTyping({});
      dispatch({ type: 'keepOnly', conversationId: openIdRef.current });
      loadConversations();
      if (openIdRef.current) loadLatest(openIdRef.current);
    });

    socket.on('message', (message) => {
      dispatch({ type: 'received', message });
      changeList((list) => applyMessage(list, message, userIdRef.current));
      removeTypist(message.conversationId, message.username); // they sent it: no longer typing
    });

    // A conversation I joined, created or was added to, from this tab or another.
    socket.on('conversation:joined', (conversation) => {
      changeList((list) => upsertConversation(list, conversation));
    });

    // One I left, maybe in another tab: it goes, and so does its view.
    socket.on('conversation:left', ({ conversationId }) => {
      changeList((list) => removeConversation(list, conversationId));
      dispatch({ type: 'forget', conversationId });
      if (openIdRef.current === conversationId) navigate('/chat', { replace: true });
    });

    socket.on('user_typing', ({ conversationId, username }) => {
      setTyping((prev) => {
        const names = prev[conversationId] ?? [];
        return names.includes(username) ? prev : { ...prev, [conversationId]: [...names, username] };
      });
    });
    socket.on('user_stop_typing', ({ conversationId, username }) => removeTypist(conversationId, username));

    socket.on('online_count', setOnlineCount);

    // Surface server-side failures as toasts instead of silent drops.
    socket.on('error', ({ message }) => notify(message || 'Something went wrong. Please try again.'));

    socket.on('connect_error', (err) => {
      console.error('Socket error:', err.message);
      if (isAuthenticationError(err.message)) {
        // The session expired or was revoked: log out, and ProtectedRoute
        // redirects to /login.
        logout();
        return;
      }
      notify('Connection lost. Reconnecting…');
      // After a lost connection Socket.io keeps retrying by itself (socket.active). After
      // a handshake the server refused (it could not reach its database), it gives up:
      // retry here, with backoff, so the tab does not stay offline until a reload.
      if (!socket.active) handshakeRetry.schedule();
    });

    socket.on('disconnect', (reason) => {
      setConnected(false);
      // The server cut this socket off, which it does when the session ends (a logout
      // in another tab, or the session sweep), and Socket.io does not reconnect after
      // that. Ask the server: a 401 logs out through the Axios interceptor, and
      // ProtectedRoute redirects to /login; a session that is still valid reconnects.
      if (reason !== 'io server disconnect') return;
      api.get('/api/auth/me')
        .then(() => { if (active) socket.connect(); })
        .catch((err) => {
          if (err.response?.status !== 401) notify('Disconnected from the server. Reload to reconnect.');
        });
    });

    socket.connect();

    return () => {
      active = false;
      handshakeRetry.stop();
      for (const event of [
        'connect', 'message', 'conversation:joined', 'conversation:left', 'user_typing',
        'user_stop_typing', 'online_count', 'error', 'connect_error', 'disconnect',
      ]) {
        socket.off(event);
      }
      socket.disconnect();
    };
  }, [changeList, loadConversations, loadLatest, logout, navigate, notify]);

  // The sidebar does not wait for the socket.
  useEffect(() => {
    // It sets state only once the response is in, not during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadConversations();
  }, [loadConversations]);

  // ── Sending ────────────────────────────────────────────────────────────────
  /** Sends a message; false (nothing sent, keep the text) while disconnected. */
  const sendMessage = useCallback((conversationId, content) => {
    if (!socket.connected) return false;
    socket.emit('new_message', { conversationId, content });
    return true;
  }, []);

  const typingSentRef = useRef({});
  const sendTyping = useCallback((conversationId) => {
    const now = Date.now();
    if (!socket.connected || now - (typingSentRef.current[conversationId] ?? 0) < TYPING_EVERY_MS) return;
    typingSentRef.current[conversationId] = now;
    socket.emit('typing', { conversationId });
  }, []);

  // ── Membership ─────────────────────────────────────────────────────────────
  // Each answers with the conversation's summary, which also reaches every tab as
  // conversation:joined; adding it here too makes it show at once in this one.
  const addToList = useCallback((conversation) => {
    changeList((list) => upsertConversation(list, conversation));
    return conversation;
  }, [changeList]);

  const joinChannel = useCallback(async (conversationId) => {
    const { data } = await api.post(`/api/conversations/${conversationId}/join`, {});
    return addToList(data.conversation);
  }, [addToList]);

  const createChannel = useCallback(async (channel) => {
    const { data } = await api.post('/api/channels', channel);
    return addToList(data.conversation);
  }, [addToList]);

  const openDm = useCallback(async (userId) => {
    const { data } = await api.post('/api/dms', { userId });
    return addToList(data.conversation);
  }, [addToList]);

  const addMember = useCallback(async (conversationId, username) => {
    await api.post(`/api/conversations/${conversationId}/members`, { username });
  }, []);

  const leaveConversation = useCallback(async (conversationId) => {
    await api.post(`/api/conversations/${conversationId}/leave`, {});
    changeList((list) => removeConversation(list, conversationId));
    dispatch({ type: 'forget', conversationId });
    navigate('/chat', { replace: true });
  }, [changeList, navigate]);

  const value = useMemo(() => ({
    conversations, listStatus, timelines, typing, onlineCount, connected, toasts,
    loadLatest, loadOlder, sendMessage, sendTyping, notify,
    joinChannel, createChannel, openDm, addMember, leaveConversation,
  }), [
    conversations, listStatus, timelines, typing, onlineCount, connected, toasts,
    loadLatest, loadOlder, sendMessage, sendTyping, notify,
    joinChannel, createChannel, openDm, addMember, leaveConversation,
  ]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
