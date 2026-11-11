import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  api,
  currentSession,
  ensureSession,
  getPublicConfig,
  type MatchMode,
  type RoomView,
} from '../../api/client';
import { friendlyError } from '../../api/errors';
import { useTurnstile } from '../../turnstile/useTurnstile';
import { InviteCodeInput } from './InviteCodeInput';
import { codeSlots } from '../../ui/pieces';
import { MODE_BLURBS } from '../../lib/copy';
import { defaultNickname, rememberNickname } from '../../lib/nickname';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { MAX_NICKNAME_LENGTH, MIN_NICKNAME_LENGTH } from '@anonyma/contracts';

const MODES: { id: MatchMode; title: string }[] = [
  { id: 'text', title: 'Text' },
  { id: 'voice', title: 'Voice' },
  { id: 'video', title: 'Video' },
];

const MIN_NICK = MIN_NICKNAME_LENGTH;

export function LobbyPage() {
  useDocumentTitle('Rooms · Anonyma');
  const navigate = useNavigate();
  const turnstile = useTurnstile();
  const [nickname, setNickname] = useState(defaultNickname);
  const [mode, setMode] = useState<MatchMode>('text');
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [inviteCode, setInviteCode] = useState('');
  /** The last join with this code failed: the slots show the error. */
  const [inviteInvalid, setInviteInvalid] = useState(false);
  useEffect(() => void codeSlots.preload(), []);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mediaOk, setMediaOk] = useState(true);
  const [sessionReady, setSessionReady] = useState(false);
  /** The public list has answered once (before that, "no rooms" would be a guess). */
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [ttlMinutes, setTtlMinutes] = useState(10);

  async function refreshRooms() {
    try {
      setRooms(await api.listRooms());
      setListError(null);
    } catch (err) {
      setListError(friendlyError(err, 'Could not load public rooms'));
    } finally {
      setRoomsLoaded(true);
    }
  }

  useEffect(() => {
    void getPublicConfig(true).then((cfg) => {
      setMediaOk(Boolean(cfg.voiceEnabled));
      if (cfg.messageTtlSeconds) setTtlMinutes(Math.round(cfg.messageTtlSeconds / 60));
    });
  }, []);

  async function prepareSession() {
    if (await currentSession()) return;
    // One token for session only — create/join take a fresh token after reset.
    // takeToken waits for the Turnstile config, so no token-less attempt goes out.
    await ensureSession(await turnstile.takeToken());
  }

  // Resolve the session once (listRooms requires it): the cookie's, else a new
  // one as soon as Turnstile hands a token.
  useEffect(() => {
    if (sessionReady) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!(await currentSession())) {
          await ensureSession(await turnstile.takeToken());
        }
        if (!cancelled) setSessionReady(true);
      } catch (err) {
        if (!cancelled) setListError(friendlyError(err, 'Could not start session'));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- takeToken waits for readiness itself
  }, [sessionReady]);

  // Poll public rooms only once there is a session (a 401 every 12 s otherwise).
  useEffect(() => {
    if (!sessionReady) return;
    void refreshRooms();
    const id = window.setInterval(() => void refreshRooms(), 12_000);
    return () => window.clearInterval(id);
  }, [sessionReady]);

  function nickOk(): boolean {
    const n = nickname.trim();
    if (n.length < MIN_NICK) {
      setError(`Nickname needs at least ${MIN_NICK} characters`);
      return false;
    }
    rememberNickname(n);
    return true;
  }

  async function assertMediaReady(forMode: MatchMode = mode) {
    if (forMode === 'text') return;
    if (!(await getPublicConfig(true)).voiceEnabled) {
      setMediaOk(false);
      throw new Error('Live media is not available right now. Pick text.');
    }
  }

  async function createRoom(type: 'public' | 'private') {
    if (!nickOk()) return;
    setBusy(true);
    setError(null);
    try {
      await prepareSession();
      await assertMediaReady();
      const result = await api.createRoom({
        type,
        mode,
        nickname: nickname.trim(),
        turnstileToken: await turnstile.takeToken(),
      });
      if (result.inviteCode) {
        setInviteCode(result.inviteCode);
      }
      navigate(`/chat/${result.room.id}`, {
        state: {
          nickname: nickname.trim(),
          inviteCode: result.inviteCode,
          mode: result.room.mode ?? mode,
          roomType: result.room.type ?? type,
        },
      });
    } catch (err) {
      setError(friendlyError(err, 'Could not create room'));
    } finally {
      setBusy(false);
    }
  }

  async function joinByInvite(e: FormEvent) {
    e.preventDefault();
    if (!nickOk()) return;
    setBusy(true);
    setError(null);
    try {
      await prepareSession();
      const room = await api.joinRoom({
        nickname: nickname.trim(),
        inviteCode: inviteCode.trim(),
        turnstileToken: await turnstile.takeToken(),
      });
      // The room's mode is only known after joining: if it is a call room and calls
      // are down, step back out instead of leaving the person in a room they can't use.
      try {
        await assertMediaReady(room.mode ?? 'text');
      } catch (mediaErr) {
        void api.leaveRoom(room.id).catch(() => undefined);
        throw mediaErr;
      }
      navigate(`/chat/${room.id}`, {
        state: {
          nickname: nickname.trim(),
          inviteCode: inviteCode.trim(),
          mode: room.mode ?? 'text',
          roomType: room.type,
        },
      });
    } catch (err) {
      setInviteInvalid(true);
      setError(friendlyError(err, 'Could not join with that invite'));
    } finally {
      setBusy(false);
    }
  }

  async function joinPublic(room: RoomView) {
    if (!nickOk()) return;
    setBusy(true);
    setError(null);
    try {
      await prepareSession();
      await assertMediaReady(room.mode ?? 'text');
      const joined = await api.joinRoom({
        nickname: nickname.trim(),
        roomId: room.id,
        slug: room.slug,
        turnstileToken: await turnstile.takeToken(),
      });
      navigate(`/chat/${joined.id}`, {
        state: {
          nickname: nickname.trim(),
          mode: joined.mode ?? room.mode ?? 'text',
          roomType: joined.type ?? room.type ?? 'public',
        },
      });
    } catch (err) {
      setError(friendlyError(err, 'Could not join room'));
    } finally {
      setBusy(false);
    }
  }

  const blocked = busy || (turnstile.required && !turnstile.ready);
  // Strict filter: voice/video selection shows only matching rooms (no silent fallback).
  const list = mode === 'text' ? rooms : rooms.filter((r) => (r.mode ?? 'text') === mode);

  const needsVerify = turnstile.required && !turnstile.ready;

  return (
    <main className="panel">
      <h1>Rooms</h1>
      <p className="muted">
        Pick text, voice, or video for new rooms. Public list refreshes every few seconds.
      </p>

      <div
        className="turnstile-slot"
        ref={turnstile.hostRef}
        hidden={!turnstile.required}
        aria-label="Human verification"
      />
      {needsVerify ? (
        <p className="muted verify-hint" aria-live="polite">
          Complete verification to create or join a room.
        </p>
      ) : null}

      <div className="match-modes" role="radiogroup" aria-label="Mode">
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
              disabled={mediaBlocked}
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
          <label htmlFor="nickname">Nickname</label>
          <input
            id="nickname"
            value={nickname}
            minLength={MIN_NICK}
            maxLength={MAX_NICKNAME_LENGTH}
            onChange={(e) => setNickname(e.target.value)}
          />
        </div>
        <div className="cta-row" style={{ alignItems: 'end' }}>
          <button
            className="btn btn-primary"
            disabled={blocked}
            onClick={() => void createRoom('public')}
          >
            Public room
          </button>
          <button
            className="btn btn-ghost"
            disabled={blocked}
            onClick={() => void createRoom('private')}
          >
            Private room
          </button>
        </div>
      </div>

      <form className="grid-actions" onSubmit={(e) => void joinByInvite(e)}>
        <div className="field">
          <label htmlFor="invite">Invite code</label>
          <InviteCodeInput
            value={inviteCode}
            invalid={inviteInvalid}
            onChange={(code) => {
              setInviteInvalid(false);
              setInviteCode(code);
            }}
          />
        </div>
        <div className="cta-row" style={{ alignItems: 'end' }}>
          <button className="btn btn-primary" disabled={blocked || !inviteCode.trim()}>
            Join with invite
          </button>
        </div>
      </form>

      {error || turnstile.error ? (
        <p className="error" role="alert">
          {error || turnstile.error}
        </p>
      ) : null}

      <div className="lobby-public-head">
        <h2>Public now</h2>
        <button
          type="button"
          className="btn btn-ghost btn-compact"
          onClick={() => void refreshRooms()}
        >
          Refresh
        </button>
      </div>
      {listError ? (
        <p className="error" role="alert">
          {listError}
        </p>
      ) : null}
      <ul className="room-list" aria-busy={!roomsLoaded}>
        {!roomsLoaded && !listError ? <li className="muted">Loading rooms…</li> : null}
        {roomsLoaded && list.length === 0 && !listError ? (
          <li>
            {mode === 'text'
              ? 'No public rooms yet.'
              : `No public ${mode} rooms right now. Create one or switch to text.`}
          </li>
        ) : null}
        {list.map((room) => (
          <li key={room.id} data-mode={room.mode ?? 'text'}>
            <div>
              <strong>#{room.slug}</strong>
              <div className="muted">
                {room.memberCount} {room.memberCount === 1 ? 'member' : 'members'}
                {room.mode && room.mode !== 'text' ? ` · ${room.mode}` : ''}
              </div>
            </div>
            <button
              className="btn btn-ghost"
              disabled={blocked}
              onClick={() => void joinPublic(room)}
            >
              Join
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
