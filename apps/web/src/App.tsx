import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, currentSession } from './api/client';
import { LandingPage } from './features/landing/LandingPage';
import { LobbyPage } from './features/lobby/LobbyPage';
import { ChatPage } from './features/chat/ChatPage';
import { MatchPage } from './features/match/MatchPage';
import { StatusPage } from './features/status/StatusPage';
import { NotFoundPage } from './features/not-found/NotFoundPage';
import { MonitoringPage } from './features/monitoring/MonitoringPage';
import { ThemeToggle } from './ui/ThemeToggle';

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void currentSession()
      .then((session) => {
        if (!cancelled) setHasSession(Boolean(session));
      })
      .catch(() => {
        if (!cancelled) setHasSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  async function logout() {
    try {
      await api.deleteSession();
    } catch {
      /* already gone */
    }
    setHasSession(false);
    navigate('/');
  }

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          Anonyma
        </Link>
        <nav aria-label="Primary">
          <NavLink to="/lobby" className={({ isActive }) => (isActive ? 'nav-active' : undefined)}>
            Rooms
          </NavLink>
          <NavLink to="/match" className={({ isActive }) => (isActive ? 'nav-active' : undefined)}>
            Match
          </NavLink>
          <NavLink to="/status" className={({ isActive }) => (isActive ? 'nav-active' : undefined)}>
            Status
          </NavLink>
          <NavLink
            to="/monitoring"
            className={({ isActive }) => (isActive ? 'nav-active' : undefined)}
          >
            Monitoring
          </NavLink>
          {hasSession ? (
            <button
              type="button"
              className="btn btn-ghost btn-compact nav-logout"
              onClick={() => void logout()}
            >
              End session
            </button>
          ) : null}
          <ThemeToggle />
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/lobby" element={<LobbyPage />} />
        <Route path="/rooms" element={<Navigate to="/lobby" replace />} />
        <Route path="/match" element={<MatchPage />} />
        <Route path="/chat/:roomId" element={<ChatPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/monitoring" element={<MonitoringPage />} />
        <Route path="/monitoring/:section" element={<MonitoringPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </div>
  );
}
