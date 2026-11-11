import { useEffect, useState } from 'react';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

import { statusMark } from '../../ui/pieces';

// Each check's mark morphs from a spinning arc to a check or a cross (React Bits
// Status Mark); the plain dot shows until it loads.
const MARK = { checking: 'running', up: 'done', down: 'failed', off: 'cancelled' } as const;

type CheckState = 'checking' | 'up' | 'down' | 'off';

interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail?: string;
}

async function probe(path: string): Promise<{ ok: boolean; detail: string; json?: unknown }> {
  const started = performance.now();
  try {
    const res = await fetch(path, { credentials: 'omit', cache: 'no-store' });
    const ms = Math.round(performance.now() - started);
    if (!res.ok) return { ok: false, detail: `${res.status} · ${ms}ms` };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { ok: true, detail: `${ms}ms`, json };
  } catch {
    return { ok: false, detail: 'unreachable' };
  }
}

function probeWs(wsUrl: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const started = performance.now();
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      resolve({ ok: false, detail: 'bad url' });
      return;
    }
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ ok, detail });
    };
    const timer = window.setTimeout(() => done(false, 'timeout'), 4_000);
    ws.onopen = () => {
      window.clearTimeout(timer);
      // Auth will fail without a ticket — open socket is enough to prove the edge is up.
      done(true, `${Math.round(performance.now() - started)}ms`);
    };
    ws.onerror = () => {
      window.clearTimeout(timer);
      done(false, 'error');
    };
  });
}

export function StatusPage() {
  useDocumentTitle('Status · Anonyma');
  useEffect(() => void statusMark.preload(), []);
  const [checks, setChecks] = useState<Check[]>([
    { id: 'web', label: 'Web', state: 'checking' },
    { id: 'api', label: 'API', state: 'checking' },
    { id: 'ready', label: 'Core / match', state: 'checking' },
    { id: 'realtime', label: 'Realtime', state: 'checking' },
    { id: 'voice', label: 'Voice / video', state: 'checking' },
  ]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const [api, ready, config] = await Promise.all([
        probe('/healthz'),
        probe('/readyz'),
        probe('/api/config'),
      ]);
      // The config probe above already carries the realtime address.
      let wsCheck = { ok: false, detail: config.ok ? 'no ws url' : 'config failed' };
      const wsUrl =
        config.json && typeof config.json === 'object'
          ? (config.json as { wsUrl?: string }).wsUrl
          : undefined;
      if (wsUrl) {
        wsCheck = await probeWs(wsUrl);
      }
      const cfgJson =
        config.json && typeof config.json === 'object'
          ? (config.json as { voiceEnabled?: boolean; voiceConfigured?: boolean })
          : null;
      const voiceEnabled = Boolean(cfgJson?.voiceEnabled);
      const voiceConfigured = Boolean(cfgJson?.voiceConfigured ?? cfgJson?.voiceEnabled);
      if (cancelled) return;
      setChecks([
        { id: 'web', label: 'Web', state: 'up', detail: 'ok' },
        { id: 'api', label: 'API', state: api.ok ? 'up' : 'down', detail: api.detail },
        {
          id: 'ready',
          label: 'Core / match',
          state: ready.ok ? 'up' : 'down',
          detail: ready.detail,
        },
        {
          id: 'realtime',
          label: 'Realtime',
          state: wsCheck.ok ? 'up' : 'down',
          detail: wsCheck.detail,
        },
        {
          id: 'voice',
          label: 'Voice / video',
          state: !config.ok ? 'down' : voiceEnabled ? 'up' : voiceConfigured ? 'down' : 'off',
          detail: !config.ok
            ? config.detail
            : voiceEnabled
              ? 'available'
              : voiceConfigured
                ? 'unreachable'
                : 'not configured',
        },
      ]);
    }

    void run();
    const id = window.setInterval(() => void run(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const failing = checks.some((c) => c.state === 'down');
  const checking = checks.some((c) => c.state === 'checking');
  const overall = checking
    ? 'Checking…'
    : failing
      ? 'Some systems are down'
      : 'All systems operational';

  return (
    <main className="panel">
      <h1>Status</h1>
      <p className="muted">Live checks for Anonyma. Refreshes every 30 seconds.</p>
      <p className={`status-overall ${!failing && !checking ? 'ok' : ''}`.trim()}>{overall}</p>
      <ul className="status-list">
        {checks.map((c) => (
          <li key={c.id} className={`status-item status-${c.state}`}>
            <span className="status-mark" aria-hidden="true">
              <statusMark.Piece
                fallback={<span className="status-dot" />}
                status={MARK[c.state]}
                size={20}
                color="var(--ink-faint)"
                doneColor="var(--online)"
                errorColor="var(--danger)"
              />
            </span>
            <div>
              <strong>{c.label}</strong>
              <div className="muted">{c.detail ?? c.state}</div>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
