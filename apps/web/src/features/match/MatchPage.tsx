import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  api,
  currentSession,
  ensureSession,
  getPublicConfig,
  type MatchMode,
} from '../../api/client';
import { friendlyError } from '../../api/errors';
import { useTurnstile } from '../../turnstile/useTurnstile';
import { defaultNickname, rememberNickname } from '../../lib/nickname';
import { MODE_BLURBS } from '../../lib/copy';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import LatticeLoader from '../../ui/reactbits/LatticeLoader';
import { decryptedText } from '../../ui/pieces';
import {
  MATCH_QUEUE_TTL_SECONDS,
  MAX_NICKNAME_LENGTH,
  MIN_NICKNAME_LENGTH,
} from '@anonyma/contracts';

const MODES: { id: MatchMode; title: string }[] = [
  { id: 'text', title: 'Text' },
  { id: 'voice', title: 'Voice' },
  { id: 'video', title: 'Video' },
];

/** The server keeps a queue entry this long (with a 10 s margin); past it a stop is a real time-out. */
const QUEUE_LIFETIME_SECS = MATCH_QUEUE_TTL_SECONDS - 10;

const MIN_NICK = MIN_NICKNAME_LENGTH;

type LocState = {
  autoNext?: boolean;
  mode?: MatchMode;
  nickname?: string;
  /** Room we just left via Next — ignore stale pair status for this id. */
  leftRoomId?: string;
};

export function MatchPage() {
  useDocumentTitle('Match · Anonyma');
  const navigate = useNavigate();
  const location = useLocation();
  const navState = (location.state as LocState | null) ?? {};
  const [nickname, setNickname] = useState(() => navState.nickname ?? defaultNickname());
  const [mode, setMode] = useState<MatchMode>(navState.mode ?? 'text');
  const [status, setStatus] = useState<'idle' | 'queued' | 'paired'>('idle');
  const [waitSecs, setWaitSecs] = useState(0);
  // The nickname reveal's effect, ready before a match is found.
  useEffect(() => void decryptedText.preload(), []);
  /** The matched person's nickname, shown for a moment before the room opens. */
  const [revealed, setRevealed] = useState<string | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  /** The room we are paired into while the reveal plays (not yet entered). */
  const pendingRoomRef = useRef<string | null>(null);
  const [mediaOk, setMediaOk] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ttlMinutes, setTtlMinutes] = useState(10);
  /** A find / restart / cancel request is in flight: no second one. */
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const queuedAtRef = useRef(0);
  /** Session missing → show Turnstile once; then match is challenge-free. */
  const [needChallenge, setNeedChallenge] = useState(true);
  const [sessionReady, setSessionReady] = useState(false);
  const turnstile = useTurnstile({ enabled: needChallenge });
  const pollRef = useRef<number | null>(null);
  const waitRef = useRef<number | null>(null);
  const nicknameRef = useRef(nickname);
  const modeRef = useRef(mode);
  const autoStarted = useRef(false);
  const sessionBoot = useRef(false);
  /** In the queue (or asking to be): only then does leaving the page cancel. */
  const inQueueRef = useRef(false);
  nicknameRef.current = nickname;
  modeRef.current = mode;

  useEffect(() => {
    void getPublicConfig(true).then((cfg) => {
      setMediaOk(Boolean(cfg.voiceEnabled));
      if (cfg.messageTtlSeconds) setTtlMinutes(Math.round(cfg.messageTtlSeconds / 60));
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // Closing or reloading the tab: an unmount does not run, and a normal fetch
    // is cancelled with the page. keepalive lets the cancel reach the server, so
    // nobody gets paired with a page that is gone.
    function onPageHide() {
      // Closed during the match reveal: already paired, so leave the room
      // instead of leaving the other person waiting in it alone.
      const pending = pendingRoomRef.current;
      if (pending) {
        pendingRoomRef.current = null;
        void fetch('/api/rooms/leave', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ roomId: pending }),
          keepalive: true,
        }).catch(() => undefined);
        return;
      }
      if (!inQueueRef.current) return;
      void fetch('/api/match/cancel', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        keepalive: true,
      }).catch(() => undefined);
    }
    window.addEventListener('pagehide', onPageHide);
    return () => {
      mountedRef.current = false;
      if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
      // Left the page during the reveal (the room never opened): leave it.
      if (pendingRoomRef.current) {
        void api.leaveRoom(pendingRoomRef.current).catch(() => undefined);
        pendingRoomRef.current = null;
      }
      window.removeEventListener('pagehide', onPageHide);
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (waitRef.current) window.clearInterval(waitRef.current);
      if (inQueueRef.current) {
        inQueueRef.current = false;
        void api.cancelMatch().catch(() => {
          /* leave queue */
        });
      }
    };
  }, []);

  // Resolve session once: cookie → unlock; else wait for Turnstile then create.
  useEffect(() => {
    if (sessionBoot.current) return;
    sessionBoot.current = true;
    void (async () => {
      try {
        if (await currentSession()) {
          setNeedChallenge(false);
          setSessionReady(true);
        } else {
          setNeedChallenge(true);
        }
      } catch {
        setNeedChallenge(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!needChallenge || sessionReady) return;
    if (turnstile.error) return;
    void (async () => {
      try {
        // takeToken waits for the Turnstile config and a token when one is
        // required, so no token-less attempt goes out first.
        await ensureSession(await turnstile.takeToken());
        setNeedChallenge(false);
        setSessionReady(true);
      } catch (err) {
        setError(friendlyError(err, 'Could not start session'));
        sessionBoot.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- takeToken waits for readiness itself
  }, [needChallenge, sessionReady, turnstile.error]);

  useEffect(() => {
    if (autoStarted.current) return;
    if (!navState.autoNext) return;
    if (!sessionReady) return;
    autoStarted.current = true;
    void findMatch(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionReady]);

  async function prepareSession() {
    if (!(await currentSession())) {
      await ensureSession(await turnstile.takeToken());
    }
    setNeedChallenge(false);
    setSessionReady(true);
  }

  function goToRoom(pair: {
    roomId: string;
    inviteCode?: string;
    peerNickname: string;
    mode: MatchMode;
  }) {
    if (navState.leftRoomId && pair.roomId === navState.leftRoomId) {
      return;
    }
    const open = () => {
      pendingRoomRef.current = null;
      navigate(`/chat/${pair.roomId}`, {
        state: {
          nickname: nicknameRef.current,
          peerNickname: pair.peerNickname,
          inviteCode: pair.inviteCode,
          mode: pair.mode,
        },
      });
    };
    // The match moment: the loader settles, the nickname decrypts, then the room
    // opens. Reduced motion keeps only a short beat.
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    pendingRoomRef.current = pair.roomId;
    setRevealed(pair.peerNickname || 'someone');
    if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
    revealTimerRef.current = window.setTimeout(open, reduce ? 400 : 1700);
  }

  function stopTimers() {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
    if (waitRef.current) window.clearInterval(waitRef.current);
    waitRef.current = null;
  }

  function startPolling(resetClock = true) {
    stopTimers();
    if (resetClock) {
      setWaitSecs(0);
      queuedAtRef.current = Date.now();
    }
    waitRef.current = window.setInterval(() => setWaitSecs((s) => s + 1), 1000);
    pollRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const result = await api.matchStatus();
          if (!mountedRef.current || !inQueueRef.current) return;
          if (result.status === 'paired' && result.pair) {
            inQueueRef.current = false;
            stopTimers();
            setStatus('paired');
            goToRoom({ ...result.pair, mode: result.pair.mode ?? modeRef.current });
          } else if (result.status === 'queued') {
            setStatus('queued');
          } else if (result.status === 'idle') {
            const waited = (Date.now() - queuedAtRef.current) / 1000;
            if (waited < QUEUE_LIFETIME_SECS) {
              // The server dropped the entry (a hidden tab polled too slowly):
              // still searching from the person's view, so quietly join again.
              stopTimers();
              void rejoinQueue();
              return;
            }
            inQueueRef.current = false;
            stopTimers();
            setStatus('idle');
            setWaitSecs(0);
            setError('No one was found in time. Try again.');
          }
        } catch (err) {
          if (mountedRef.current) setError(friendlyError(err, 'Lost touch with the queue'));
        }
      })();
    }, 1500);
  }

  async function rejoinQueue() {
    try {
      const result = await api.enqueueMatch(nicknameRef.current.trim(), modeRef.current, false);
      if (!mountedRef.current || !inQueueRef.current) {
        if (result.status === 'queued') void api.cancelMatch().catch(() => undefined);
        return;
      }
      if (result.status === 'paired' && result.pair) {
        inQueueRef.current = false;
        setStatus('paired');
        goToRoom({ ...result.pair, mode: result.pair.mode ?? modeRef.current });
        return;
      }
      startPolling(false);
    } catch (err) {
      if (!mountedRef.current) return;
      inQueueRef.current = false;
      setStatus('idle');
      setError(friendlyError(err, 'Could not keep searching'));
    }
  }

  async function findMatch(next = false) {
    if (busy) return;
    setError(null);
    const nick = nickname.trim();
    if (nick.length < MIN_NICK) {
      setError(`Nickname needs at least ${MIN_NICK} characters`);
      return;
    }
    rememberNickname(nick);
    setBusy(true);
    // A restart must not race the running poller (it could read "idle" in between).
    stopTimers();
    try {
      await prepareSession();
      if ((mode === 'voice' || mode === 'video') && !(await getPublicConfig(true)).voiceEnabled) {
        setError('Live media is not available right now. Try text match.');
        setMediaOk(false);
        return;
      }
      inQueueRef.current = true;
      const result = await api.enqueueMatch(nick, mode, next);
      if (!mountedRef.current) {
        // Left the page while the request was out: undo it instead of being
        // queued (or put in a room) from a page that is gone.
        if (result.status === 'paired' && result.pair) {
          void api.leaveRoom(result.pair.roomId).catch(() => undefined);
        } else {
          void api.cancelMatch().catch(() => undefined);
        }
        return;
      }
      if (result.status === 'paired' && result.pair) {
        inQueueRef.current = false;
        setStatus('paired');
        goToRoom({ ...result.pair, mode: result.pair.mode ?? mode });
        return;
      }
      setStatus('queued');
      startPolling();
    } catch (err) {
      inQueueRef.current = false;
      if (!mountedRef.current) return;
      setError(friendlyError(err, 'Could not start matching'));
      setStatus('idle');
      stopTimers();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function cancel() {
    if (busy) return;
    setBusy(true);
    stopTimers();
    try {
      await api.cancelMatch();
      inQueueRef.current = false;
      setStatus('idle');
      setWaitSecs(0);
      setError(null);
    } catch (err) {
      setError(friendlyError(err, 'Could not leave the queue'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  // While the match is being revealed the room is already chosen: nothing here
  // may start, change or cancel a search.
  const blocked =
    Boolean(revealed) || !sessionReady || (needChallenge && turnstile.required && !turnstile.ready);
  const modeLabel = MODES.find((m) => m.id === mode)?.title ?? 'Text';

  return (
    <main className="panel">
      <h1>Random match</h1>
      <p className="muted">Pick how you want to meet — three separate queues.</p>

      {needChallenge ? (
        <div
          className="turnstile-slot"
          ref={turnstile.hostRef}
          hidden={!turnstile.required}
          aria-label="Human verification"
        />
      ) : null}
      {!sessionReady && !error ? (
        <p className="muted verify-hint" aria-live="polite">
          {needChallenge && turnstile.required && !turnstile.ready
            ? 'Complete verification to start matching…'
            : 'Preparing session…'}
        </p>
      ) : null}

      <div className="match-modes" role="radiogroup" aria-label="Match type">
        {MODES.map((m) => {
          const mediaBlocked = m.id !== 'text' && !mediaOk;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              className={`match-mode ${mode === m.id ? 'active' : ''}`.trim()}
              data-mode={m.id}
              disabled={status === 'queued' || Boolean(revealed) || mediaBlocked}
              onClick={() => setMode(m.id)}
              title={mediaBlocked ? 'Live media unavailable' : undefined}
            >
              <strong>{m.title}</strong>
              <span className="muted">
                {mediaBlocked ? 'Unavailable right now.' : MODE_BLURBS[m.id](ttlMinutes)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid-actions">
        <div className="field">
          <label htmlFor="match-nick">Nickname</label>
          <input
            id="match-nick"
            value={nickname}
            minLength={MIN_NICK}
            maxLength={MAX_NICKNAME_LENGTH}
            onChange={(e) => setNickname(e.target.value)}
            disabled={status === 'queued' || Boolean(revealed)}
          />
        </div>
        <div className="cta-row" style={{ alignItems: 'end' }}>
          {status !== 'queued' ? (
            <button
              className="btn btn-primary"
              disabled={blocked || busy}
              onClick={() => void findMatch(false)}
            >
              {busy ? 'Searching…' : `Find ${modeLabel.toLowerCase()} match`}
            </button>
          ) : (
            <>
              <button className="btn btn-ghost" disabled={busy} onClick={() => void cancel()}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void findMatch(true)}
                title="Leave the queue and start searching again"
              >
                Restart search
              </button>
            </>
          )}
        </div>
      </div>

      {status === 'queued' || revealed ? (
        <div className="match-wait">
          {/* The loader announces the wait and the match itself (role=status);
              its stopwatch stays out of the live region. */}
          <LatticeLoader
            label={`Waiting for a ${modeLabel.toLowerCase()} match`}
            doneLabel="Matched in"
            status={revealed ? 'done' : 'working'}
            elapsed={waitSecs}
            color="var(--accent)"
            doneColor="var(--online)"
            cellSize={7}
            gap={3}
            fontSize={15}
          />
          {revealed ? (
            <p className="match-reveal">
              You are talking to{' '}
              <strong>
                <decryptedText.Piece
                  fallback={revealed}
                  text={revealed}
                  animateOn="view"
                  sequential
                  speed={55}
                  encryptedClassName="hero-scramble"
                />
              </strong>
            </p>
          ) : null}
        </div>
      ) : null}
      {error || turnstile.error ? (
        <p className="error" role="alert">
          {error || turnstile.error}
        </p>
      ) : null}
    </main>
  );
}
