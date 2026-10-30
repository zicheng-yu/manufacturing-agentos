import type { Catalog, Session, StreamMessage } from '@agentos/shared';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from './api.ts';

type Listener = (message: StreamMessage) => void;

interface SessionState {
  session: Session | null;
  catalog: Catalog | null;
  ready: boolean;
  live: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** Receive live messages from /api/stream. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void;
}

const SessionContext = createContext<SessionState | null>(null);

const KINDS: StreamMessage['kind'][] = [
  'event.created',
  'event.updated',
  'signal.raised',
  'signal.updated',
  'signal.cleared',
  'situation.updated',
  'task.created',
];

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [ready, setReady] = useState(false);
  const [live, setLive] = useState(false);
  const listeners = useRef(new Set<Listener>());

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api<Session>('/api/session'), api<Catalog>('/api/catalog')]);
      setSession(s);
      setCatalog(c);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      setSession(null);
      setCatalog(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!session) return;
    const source = new EventSource('/api/stream');
    source.addEventListener('ready', () => setLive(true));
    source.onerror = () => setLive(false);
    for (const kind of KINDS) {
      source.addEventListener(kind, (e) => {
        const message = JSON.parse((e as MessageEvent<string>).data) as StreamMessage;
        for (const listener of listeners.current) listener(message);
      });
    }
    return () => {
      source.close();
      setLive(false);
    };
  }, [session]);

  const value: SessionState = {
    session,
    catalog,
    ready,
    live,
    async login(username, password) {
      await api('/api/auth/login', { method: 'POST', body: { username, password } });
      await load();
    },
    async logout() {
      await api('/api/auth/logout', { method: 'POST' });
      setSession(null);
      setCatalog(null);
    },
    subscribe(listener) {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

/** Subscribe to live messages for the lifetime of the component. */
export function useLive(listener: Listener) {
  const { subscribe } = useSession();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => subscribe((m) => ref.current(m)), [subscribe]);
}
