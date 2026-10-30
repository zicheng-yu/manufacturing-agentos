import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout.tsx';
import './index.css';
import { Accounts } from './pages/Accounts.tsx';
import { Agents } from './pages/Agents.tsx';
import { Cockpit } from './pages/Cockpit.tsx';
import { Events } from './pages/Events.tsx';
import { Login } from './pages/Login.tsx';
import { ModulePage } from './pages/ModulePage.tsx';
import { SessionProvider, useSession } from './session.tsx';
import { Spinner } from './ui.tsx';

function App() {
  const { session, ready } = useSession();
  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        <Spinner />
      </div>
    );
  }
  if (!session) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Cockpit />} />
        <Route path="agents" element={<Agents />} />
        <Route path="agents/:agentId" element={<Agents />} />
        <Route path="agents/:agentId/:conversationId" element={<Agents />} />
        <Route path="m/:domain" element={<ModulePage />} />
        <Route path="events" element={<Events />} />
        {session.account.role === 'executive' && <Route path="accounts" element={<Accounts />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
