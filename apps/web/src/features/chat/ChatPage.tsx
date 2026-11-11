import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  currentSession,
  ensureSession,
  errorCode,
  errorStatus,
  getPublicConfig,
  type MatchMode,
  type MessageView,
  type PublicConfig,
  type RoomMemberView,
  type RoomReadMap,
  type RoomView,
} from '../../api/client';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { MediaCall } from '../call/MediaCall';
import { Composer } from './Composer';
import { HoldToLeave } from './HoldToLeave';
import { ArrowDown, iconStroke } from '../../ui/icons';
import GradualBlur from '../../ui/reactbits/GradualBlur';
import { lazyPiece } from '../../ui/lazyPiece';
import { MessageItem } from './MessageItem';
import { PeerAbsentBanner, PeerLeftBanner, WhoHere } from './RoomBanners';
import { ErrorCodes, MAX_NICKNAME_LENGTH } from '@anonyma/contracts';
import { friendlyError } from '../../api/errors';
import { useTurnstile } from '../../turnstile/useTurnstile';
import { defaultNickname, rememberNickname } from '../../lib/nickname';
import { clearRoomSession, readRoomSession, saveRoomSession } from '../../lib/roomSession';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import {
  applyMessageChange,
  applyNewMessage,
  applyReaction,
  isSelfMember,
  mergeLatest,
  normalizeMessage,
  peerSeenCount,
} from './frames';

type ChatLocationState = {
  inviteCode?: string;
  peerNickname?: string;
  nickname?: string;
  mode?: MatchMode;
  roomType?: 'public' | 'private' | 'match';
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

// The invite ticket (and its animation library) loads only in a waiting private room.
const inviteTicket = lazyPiece(() => import('./InviteTicket'));

export function ChatPage() {
  const { roomId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const navState = (location.state as ChatLocationState | null) ?? {};
  const stored = roomId ? readRoomSession(roomId) : null;
  // Share links carry the invite after `#` (never sent to a server, so it stays
  // out of access logs); `?invite=` is still read for links shared before.
  const inviteFromUrl = useMemo(() => {
    const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('invite');
    const raw = fromHash ?? new URLSearchParams(location.search).get('invite');
    return raw?.trim() || '';
  }, [location.search, location.hash]);

  const [room, setRoom] = useState<RoomView | null>(null);
  /** Room id whose getRoom succeeded: this session is a member there. */
  const [memberOf, setMemberOf] = useState('');
  const [inviteCode, setInviteCode] = useState(
    navState.inviteCode ?? stored?.inviteCode ?? inviteFromUrl ?? '',
  );
  const [peerNickname, setPeerNickname] = useState(
    navState.peerNickname ?? stored?.peerNickname ?? '',
  );
  const [nickname, setNickname] = useState(
    () => navState.nickname ?? stored?.nickname ?? defaultNickname(),
  );
  const [mode, setMode] = useState<MatchMode>(navState.mode ?? stored?.mode ?? 'text');
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [reads, setReads] = useState<RoomReadMap>({});
  const [members, setMembers] = useState<RoomMemberView[]>([]);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);
  const [editing, setEditing] = useState<MessageView | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [online, setOnline] = useState(0);
  const [peerTyping, setPeerTyping] = useState(false);
  const [copied, setCopied] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [peerLeft, setPeerLeft] = useState(false);
  const [connToast, setConnToast] = useState<string | null>(null);
  /** Soften chat WS toast while LiveKit media is live (UX-M01). */
  const [mediaCallLive, setMediaCallLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsJoin, setNeedsJoin] = useState(false);
  const [joining, setJoining] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** The room was deleted or expired while open (404 from the server). */
  const [roomGone, setRoomGone] = useState(false);
  /** Match room: the other person has no live connection (never came, or went away). */
  const [peerAbsent, setPeerAbsent] = useState(false);
  const composerRef = useRef<HTMLInputElement | null>(null);
  /** Unsent text from before an edit started; it comes back when the edit ends. */
  const draftBeforeEditRef = useRef('');
  /** Sends go out one after another, in the order they were typed. */
  const sendChainRef = useRef<Promise<void>>(Promise.resolve());
  const listRef = useRef<HTMLDivElement | null>(null);
  /** The list node itself: the call room's chat unmounts on "Hide chat", so a
   *  new list can appear while the room stays the same. */
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const attachList = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    setListEl(el);
  }, []);
  /** The reader is at (or near) the newest message; only then do we follow new ones. */
  const nearBottomRef = useRef(true);
  /** Scroll to the bottom on the next render no matter where the reader is (own send). */
  const forceScrollRef = useRef(true);
  /** scrollHeight before "Load earlier" prepended a page, to keep the view still. */
  const prependAnchorRef = useRef<number | null>(null);
  /** Bubble that opened the delete dialog; focus returns there (its toolbar hides). */
  const deleteReturnRef = useRef<HTMLElement | null>(null);
  /** First page of history has loaded (until then the list says "Loading…"). */
  const [historyReady, setHistoryReady] = useState(false);
  const historyLoadedRef = useRef(false);
  const historyFallbackRef = useRef<number | null>(null);
  const turnstile = useTurnstile();
  const turnstileRef = useRef(turnstile);
  turnstileRef.current = turnstile;
  const nicknameRef = useRef(nickname);
  nicknameRef.current = nickname;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const inviteCodeRef = useRef(inviteCode);
  inviteCodeRef.current = inviteCode;
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const leavingBeacon = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const typingTimer = useRef<number | null>(null);
  const typingClear = useRef<number | null>(null);
  const amTyping = useRef(false);
  /** sessionHash prefix from Who's here (self) — used to ignore typing echo */
  const selfWsHashRef = useRef('');
  /** This session's per-room id from the server (room.selfId). */
  const selfIdRef = useRef('');
  /**
   * Is this id "you"? The server now shows peers a per-room pseudonym instead of
   * the session's lasting id (so nobody can follow a person from room to room);
   * the older ids are still recognised while both kinds are around.
   */
  function isSelfId(id: string): boolean {
    if (!id) return false;
    if (id === selfIdRef.current || id === sessionIdRef.current) return true;
    const prefix = selfWsHashRef.current;
    return Boolean(prefix) && id.startsWith(prefix);
  }
  /** True once another member was seen — alone≠peerLeft until then (fresh create). */
  const hadPeerRef = useRef(Boolean(peerNickname || navState.peerNickname || stored?.peerNickname));
  const lastReadSent = useRef<string>('');
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;

  const titleSlug = room?.slug ? `#${room.slug}` : 'Room';
  useDocumentTitle(`${titleSlug} · Anonyma`);

  const expiresLabel = useMemo(() => {
    if (!config) return '10 minutes';
    return `${Math.round(config.messageTtlSeconds / 60)} minutes`;
  }, [config]);

  async function refreshMembers() {
    if (!roomId) return;
    try {
      const next = await api.listMembers(roomId);
      setMembers(next);
      // Identity is the session (server's isSelf), never the nickname: two people
      // with the same nickname were merged into one "you".
      const isMe = (m: RoomMemberView) => isSelfMember(m, nicknameRef.current);
      const me = next.find(isMe);
      if (me?.sessionId) selfWsHashRef.current = me.sessionId;
      // Derive peer nick for typing / banners when invite join didn't set it.
      const peer = next.find((m) => !isMe(m));
      if (peer?.nickname) {
        hadPeerRef.current = true;
        setPeerLeft(false);
        setPeerNickname((cur) => {
          if (cur) return cur;
          saveRoomSession(roomId, { peerNickname: peer.nickname });
          return peer.nickname;
        });
      }
      // Alone after a peer was present → banner even if room.left was missed.
      // Do NOT treat a freshly created empty room as peer-left (that showed "Match ended").
      const direct =
        room?.type === 'match' ||
        room?.type === 'private' ||
        navState.roomType === 'match' ||
        navState.roomType === 'private' ||
        stored?.roomType === 'match' ||
        stored?.roomType === 'private';
      if (direct && hadPeerRef.current && next.length <= 1) {
        const onlySelf = next.length === 0 || next.every(isMe);
        if (onlySelf) setPeerLeft(true);
      }
    } catch {
      /* optional */
    }
  }

  useEffect(() => {
    if (!roomId) return;
    const meta = {
      inviteCode: navState.inviteCode || stored?.inviteCode || inviteFromUrl || undefined,
      peerNickname: navState.peerNickname ?? stored?.peerNickname,
      nickname: navState.nickname ?? stored?.nickname,
      mode: navState.mode ?? stored?.mode,
    };
    if (meta.inviteCode || meta.peerNickname || meta.nickname || meta.mode) {
      saveRoomSession(roomId, meta);
    }
    if (inviteFromUrl && !inviteCodeRef.current) {
      setInviteCode(inviteFromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once per room
  }, [roomId]);

  async function refreshInvite() {
    if (!roomId) return;
    try {
      const { inviteCode: next } = await api.getRoomInvite(roomId);
      if (next) {
        setInviteCode(next);
        saveRoomSession(roomId, { inviteCode: next });
      }
    } catch {
      /* public rooms / no invite stored */
    }
  }

  async function resyncHistory() {
    if (!roomId) return;
    try {
      const [history, readMap] = await Promise.all([
        api.listMessages(roomId),
        api.listReads(roomId).catch(() => ({}) as RoomReadMap),
      ]);
      setMessages((prev) => mergeLatest(prev, history.map(normalizeMessage)));
      setReads(readMap);
      await refreshMembers();
      await refreshInvite();
    } catch (err) {
      if (errorStatus(err) === 404) setRoomGone(true);
    }
  }

  /**
   * The first page of history, loaded once the chat socket is subscribed: what
   * is posted after that arrives as an event, so nothing falls in between, and
   * it is one request (fetching before and again after the socket was two).
   */
  async function loadHistory() {
    if (historyLoadedRef.current) return;
    historyLoadedRef.current = true;
    if (historyFallbackRef.current !== null) {
      window.clearTimeout(historyFallbackRef.current);
      historyFallbackRef.current = null;
    }
    try {
      const history = await api.listMessages(roomId, { limit: 50 });
      setMessages((prev) => mergeLatest(prev, history.map(normalizeMessage)));
      setHasMore(history.length >= 50);
    } catch (err) {
      historyLoadedRef.current = false;
      if (errorStatus(err) === 404) setRoomGone(true);
    } finally {
      setHistoryReady(true);
    }
  }

  async function loadRoom() {
    // Room first: a visitor who has not joined yet gets one 403 here instead of
    // one per request (each showed as a red line in the console).
    const roomView = await api.getRoom(roomId);
    selfIdRef.current = roomView.selfId ?? '';
    setMemberOf(roomId);
    // History follows the socket's welcome; a slow or failing socket still gets
    // it after a short wait.
    if (!historyLoadedRef.current && historyFallbackRef.current === null) {
      historyFallbackRef.current = window.setTimeout(() => {
        historyFallbackRef.current = null;
        void loadHistory();
      }, 2500);
    }
    const readMap = await api.listReads(roomId).catch(() => ({}));
    setReads(readMap);
    setRoom(roomView);
    setNeedsJoin(false);
    setError(null);
    leavingBeacon.current = false;
    saveRoomSession(roomId, { roomType: roomView.type });
    if (roomView.mode) {
      setMode(roomView.mode);
      saveRoomSession(roomId, { mode: roomView.mode });
    }
    if (roomView.inviteCode) {
      setInviteCode((prev) => prev || roomView.inviteCode || '');
      saveRoomSession(roomId, { inviteCode: roomView.inviteCode });
    } else if (roomView.type === 'private' || roomView.type === 'match') {
      await refreshInvite();
    }
    await refreshMembers();
  }

  async function ensureChatSession() {
    const ts = turnstileRef.current;
    const session = (await currentSession()) ?? (await ensureSession(await ts.takeToken()));
    setSessionId(session.id);
    setConfig(await getPublicConfig());
  }

  function isMembershipGateError(err: unknown): boolean {
    const code = errorCode(err);
    if (code) return code === ErrorCodes.NOT_ROOM_MEMBER || code === ErrorCodes.VERIFICATION_FAILED;
    // Older servers send no code: api.parseApiError may already have humanized
    // Nest 403s — match both forms.
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return /not a room member|forbidden|\b403\b|join this room to continue|verify below|enter the room/i.test(
      msg,
    );
  }

  async function joinViaLink(opts?: {
    invite?: string;
    nick?: string;
    requireTurnstile?: boolean;
  }) {
    const ts = turnstileRef.current;
    const nick = (opts?.nick ?? nicknameRef.current).trim() || defaultNickname();
    const invite = (opts?.invite ?? inviteCodeRef.current).trim();
    // Foreign join needs a token when Turnstile is on. Already-member / skip mode: no token.
    let turnstileToken: string | undefined;
    if (opts?.requireTurnstile && ts.required) {
      turnstileToken = await ts.takeToken();
    }
    await api.joinRoom({
      nickname: nick,
      roomId,
      inviteCode: invite || undefined,
      turnstileToken,
    });
    saveRoomSession(roomId, {
      nickname: nick,
      inviteCode: invite || undefined,
    });
    await loadRoom();
  }

  useEffect(() => {
    let cancelled = false;
    // A different room: start from an empty list, not the last room's messages.
    setMessages([]);
    setHistoryReady(false);
    historyLoadedRef.current = false;
    void (async () => {
      setBootstrapping(true);
      setError(null);
      setNeedsJoin(false);
      try {
        await ensureChatSession();
        if (cancelled) return;
        try {
          await loadRoom();
        } catch (firstErr) {
          if (!isMembershipGateError(firstErr)) {
            throw firstErr;
          }
          // Deep link / refresh: challenge (when required) + join before opening the room.
          try {
            await joinViaLink({ requireTurnstile: true });
            return;
          } catch (joinErr) {
            const joinMsg = (joinErr as Error).message || '';
            const joinCode = errorCode(joinErr);
            // Gone or expired: no join form, there is nothing left to join.
            if (
              joinCode === ErrorCodes.ROOM_NOT_FOUND ||
              joinCode === ErrorCodes.ROOM_EXPIRED ||
              errorStatus(joinErr) === 404 ||
              (!joinCode && /gone or expired/i.test(joinMsg))
            ) {
              if (!cancelled) {
                setNeedsJoin(false);
                setRoomGone(true);
              }
              return;
            }
            if (
              joinCode
                ? joinCode === ErrorCodes.INVITE_REQUIRED || joinCode === ErrorCodes.INVITE_INVALID
                : /invite|private|invalid/i.test(joinMsg)
            ) {
              if (!cancelled) {
                setNeedsJoin(true);
                setError('Enter a nickname and invite code to join this room.');
              }
              return;
            }
            if (!cancelled) {
              setNeedsJoin(true);
              setError(
                friendlyError(
                  joinMsg,
                  turnstileRef.current.required
                    ? 'Verify below, then enter the room.'
                    : 'Enter a nickname to join this room.',
                ),
              );
            }
          }
        }
      } catch (err) {
        if (cancelled) return;
        const msg = (err as Error).message || 'Failed to open room';
        if (isMembershipGateError(err)) {
          setNeedsJoin(true);
          setError(
            friendlyError(
              msg,
              turnstileRef.current.required
                ? 'Verify below, then enter the room.'
                : 'Enter a nickname to join this room.',
            ),
          );
        } else {
          setError(friendlyError(msg, 'Could not open this room.'));
        }
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
      if (historyFallbackRef.current !== null) {
        window.clearTimeout(historyFallbackRef.current);
        historyFallbackRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bootstrap once room is known
  }, [roomId]);

  async function submitDeepJoin(e: FormEvent) {
    e.preventDefault();
    if (!nickname.trim()) {
      setError('Pick a nickname first');
      return;
    }
    setJoining(true);
    setError(null);
    rememberNickname(nickname);
    try {
      await ensureChatSession();
      await joinViaLink({
        nick: nickname.trim(),
        invite: inviteCode.trim(),
        requireTurnstile: true,
      });
    } catch (err) {
      if (errorStatus(err) === 404) {
        // Nothing left to join: show the ended screen, not the form again.
        setNeedsJoin(false);
        setRoomGone(true);
        return;
      }
      setError(friendlyError(err, 'Could not join room'));
      setNeedsJoin(true);
    } finally {
      setJoining(false);
    }
  }

  // Public rooms: drop membership when leaving the chat route / tab so lobby
  // isn't full of ghosts. SPA nav does not fire pagehide — must leave on unmount.
  // Track type in a ref so discovering room.type does not re-run cleanup (that
  // used to leave mid-call → joinVoice "Not a room member"). Also delay arming
  // so React Strict Mode's mount→cleanup→mount does not leave immediately.
  const publicRoomRef = useRef((navState.roomType ?? stored?.roomType) === 'public');
  useEffect(() => {
    const t = room?.type ?? navState.roomType ?? stored?.roomType;
    if (t === 'public') publicRoomRef.current = true;
    else if (t) publicRoomRef.current = false;
  }, [room?.type, navState.roomType, stored?.roomType]);

  useEffect(() => {
    if (!roomId) return;
    let armed = false;
    const armTimer = window.setTimeout(() => {
      armed = true;
    }, 0);

    function leavePublic() {
      if (!publicRoomRef.current) return;
      if (leavingBeacon.current) return;
      leavingBeacon.current = true;
      const body = JSON.stringify({ roomId });
      void fetch('/api/rooms/leave', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
      });
    }

    window.addEventListener('pagehide', leavePublic);
    return () => {
      window.clearTimeout(armTimer);
      window.removeEventListener('pagehide', leavePublic);
      if (armed) leavePublic();
    };
  }, [roomId]);

  async function loadEarlier() {
    if (!roomId || loadingMore || messages.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = messages[0]!.id;
      const older = await api.listMessages(roomId, { limit: 50, before: oldest });
      setHasMore(older.length >= 50);
      if (older.length === 0) return;
      prependAnchorRef.current = listRef.current?.scrollHeight ?? null;
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const fresh = older.map(normalizeMessage).filter((m) => !ids.has(m.id));
        return [...fresh, ...prev];
      });
    } catch (err) {
      setError(friendlyError(err, 'Could not load earlier messages'));
    } finally {
      setLoadingMore(false);
    }
  }

  // A message that reaches its time is shredded (MessageItem plays it), then
  // removed. Checked every second so it goes when its time is up. A hidden tab
  // skips the show; an animation that never finishes is cut after 2.5 s.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [shredding, setShredding] = useState<ReadonlySet<string>>(() => new Set());
  const shredTimers = useRef(new Map<string, number>());

  function dropMessage(id: string) {
    const timer = shredTimers.current.get(id);
    if (timer) window.clearTimeout(timer);
    shredTimers.current.delete(id);
    setMessages((prev) => prev.filter((m) => m.id !== id));
    setShredding((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  useEffect(() => {
    const timers = shredTimers.current;
    const id = window.setInterval(() => {
      const now = Date.now();
      const due = messagesRef.current.filter(
        (m) => m.expiresAt && new Date(m.expiresAt).getTime() <= now,
      );
      if (due.length === 0) return;
      if (document.hidden) {
        const gone = new Set(due.map((m) => m.id));
        setMessages((prev) => prev.filter((m) => !gone.has(m.id)));
        return;
      }
      const fresh = due.filter((m) => !timers.has(m.id));
      if (fresh.length === 0) return;
      for (const m of fresh) {
        timers.set(
          m.id,
          window.setTimeout(() => dropMessage(m.id), 2500),
        );
      }
      setShredding((prev) => {
        const next = new Set(prev);
        for (const m of fresh) next.add(m.id);
        return next;
      });
    }, 1000);
    return () => {
      window.clearInterval(id);
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // The socket needs membership: on a deep link not yet joined the ticket was
  // refused with 403 and the chat never reconnected. Set as soon as getRoom
  // answers, so the socket still opens alongside the history fetch.
  const isMember = memberOf === roomId;

  useEffect(() => {
    if (!config || !roomId || !isMember) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let attempt = 0;
    let everConnected = false;
    let removed = false;

    function handlePayload(data: { type: string; payload?: Record<string, unknown> }) {
      if (data.type === 'welcome') {
        // Authenticated and subscribed: the connection counts as good from here.
        const wasReconnect = everConnected;
        everConnected = true;
        attempt = 0;
        setConnToast(null);
        if (wasReconnect) {
          void resyncHistory();
        } else {
          // Subscribed: from here every new message arrives as an event, so the
          // first page of history fetched now leaves no gap (the first "hi" in a
          // fresh match used to fall between the fetch and the subscription).
          if (historyLoadedRef.current) {
            // A slow socket: the fallback already fetched, so close that gap once.
            void api
              .listMessages(roomId, { limit: 50 })
              .then((latest) =>
                setMessages((prev) => mergeLatest(prev, latest.map(normalizeMessage))),
              )
              .catch(() => undefined);
          } else {
            void loadHistory();
          }
        }
        return;
      }
      if (data.type === 'resync') {
        void resyncHistory();
        return;
      }
      if (data.type === 'room.removed') {
        // This session left the room (in another tab, or by ending it): the
        // server closed the feed. Stop reconnecting and offer the way back in.
        removed = true;
        setRoom(null);
        setMemberOf('');
        setNeedsJoin(true);
        setError('You left this room. Join again to continue.');
        return;
      }
      if (data.type === 'message' && data.payload) {
        const msg = data.payload as unknown as MessageView;
        setMessages((prev) => applyNewMessage(prev, msg));
        setPeerTyping(false);
      }
      if ((data.type === 'message_updated' || data.type === 'message_deleted') && data.payload) {
        const msg = data.payload as unknown as MessageView;
        const kind = data.type;
        setMessages((prev) => applyMessageChange(prev, msg, kind));
      }
      if (data.type === 'reaction' && data.payload) {
        const messageId = String(data.payload.messageId ?? '');
        const reactions = (data.payload.reactions ?? {}) as Record<string, string[]>;
        setMessages((prev) => applyReaction(prev, messageId, reactions));
      }
      if (data.type === 'read' && data.payload?.reads) {
        setReads(data.payload.reads as RoomReadMap);
      }
      // Presence is the online count only; membership changes arrive as
      // room.joined / room.left, which refresh the member list themselves.
      if (data.type === 'presence' && data.payload?.onlineCount != null) {
        setOnline(Number(data.payload.onlineCount));
      }
      if (data.type === 'typing' && data.payload) {
        const from = String(data.payload.sessionId ?? '');
        // The server also leaves the sender out of typing fanout.
        if (isSelfId(from)) return;
        setPeerTyping(Boolean(data.payload.typing));
        if (typingClear.current) window.clearTimeout(typingClear.current);
        if (data.payload.typing) {
          typingClear.current = window.setTimeout(() => setPeerTyping(false), 2500);
        }
      }
      if (data.type === 'room.left' && data.payload) {
        const remaining = Number(data.payload.memberCount ?? -1);
        const leftSession = String(data.payload.sessionId ?? '');
        const roomType = String(
          data.payload.roomType ?? room?.type ?? navState.roomType ?? stored?.roomType ?? '',
        );
        // memberCount is members, not connections: the online count comes from presence.
        // Invite rotates server-side; pull fresh code over HTTP (never from WS).
        if (roomType === 'private' || roomType === 'match' || !roomType) {
          void refreshInvite();
        }
        const direct =
          roomType === 'match' ||
          roomType === 'private' ||
          (!roomType &&
            (navState.roomType === 'match' ||
              navState.roomType === 'private' ||
              stored?.roomType === 'match' ||
              stored?.roomType === 'private'));
        const leftIsSelf = isSelfId(leftSession);
        // Only when that leaves you alone: a third member leaving a private room used
        // to end everyone's call (MediaCall unmounts on peerLeft).
        const aloneNow = remaining >= 0 && remaining <= 1;
        if (direct && leftSession && !leftIsSelf && aloneNow) {
          hadPeerRef.current = true;
          setPeerLeft(true);
          if (roomType === 'match') {
            setPeerNickname('');
            saveRoomSession(roomId, { peerNickname: '' });
          }
        }
        void refreshMembers();
      }
      if (data.type === 'room.joined' && data.payload) {
        setPeerLeft(false);
        const nick = data.payload.nickname;
        const joinedSession = String(data.payload.sessionId ?? '');
        const joinedIsSelf = isSelfId(joinedSession);
        if (typeof nick === 'string' && nick && !joinedIsSelf) {
          hadPeerRef.current = true;
          setPeerNickname(nick);
          saveRoomSession(roomId, { peerNickname: nick });
        }
        void refreshMembers();
      }
    }

    async function connect() {
      try {
        const { ticket } = await api.wsTicket(roomId);
        if (closed) return;
        // The ticket goes in the first message only: in the URL it landed in the
        // proxy's access log, and realtime never read it there.
        ws = new WebSocket(config!.wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          // The counter resets on 'welcome' (auth accepted), not here: a refused
          // ticket closes right after open and used to retry every 800 ms forever.
          ws?.send(JSON.stringify({ type: 'auth', payload: { ticket } }));
        };

        ws.onmessage = (event) => {
          try {
            handlePayload(
              JSON.parse(event.data as string) as {
                type: string;
                payload?: Record<string, unknown>;
              },
            );
          } catch {
            // ignore malformed
          }
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (closed || removed) return;
          // Chat WS only — keep copy distinct from LiveKit media toasts.
          setConnToast('Chat reconnecting…');
          scheduleReconnect();
        };
      } catch (err) {
        if (closed) return;
        const status = errorStatus(err);
        if (status === 404) {
          // The room is gone: retrying cannot help.
          setRoomGone(true);
          return;
        }
        if (status === 403) {
          // No longer a member (left elsewhere, or removed): offer the join form.
          setRoom(null);
          setMemberOf('');
          setNeedsJoin(true);
          setError('Join this room to continue.');
          return;
        }
        // Network blip, 429, gateway restart: try again with backoff instead of
        // staying "Chat disconnected" until a reload.
        setConnToast('Chat reconnecting…');
        scheduleReconnect();
      }
    }

    function scheduleReconnect() {
      const delay = Math.min(10_000, 800 * 2 ** attempt) + Math.floor(Math.random() * 400);
      attempt += 1;
      reconnectTimer = window.setTimeout(() => {
        void connect();
      }, delay);
    }

    void connect();

    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ws?.close();
      wsRef.current = null;
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
      if (typingClear.current) window.clearTimeout(typingClear.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- room type/session stabilize after bootstrap
  }, [config, roomId, sessionId, isMember]);

  /** New messages arrived while the reader was scrolled up. */
  const [unseenBelow, setUnseenBelow] = useState(false);
  const lastScrollTopRef = useRef(0);

  const lastMessageId = messages[messages.length - 1]?.id ?? '';
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // "Load earlier" prepended a page: keep the reader where they were.
    if (prependAnchorRef.current !== null) {
      list.scrollTop += list.scrollHeight - prependAnchorRef.current;
      prependAnchorRef.current = null;
      return;
    }
    // Follow new messages only for a reader at the bottom (or after their own
    // send). Jumping on every change pulled people away from what they were reading.
    // Only the list scrolls (scrollIntoView also moved the page on some layouts).
    if (forceScrollRef.current || nearBottomRef.current) {
      forceScrollRef.current = false;
      nearBottomRef.current = true;
      list.scrollTo({
        top: list.scrollHeight,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
      setUnseenBelow(false);
    } else if (messages.length > 0) {
      setUnseenBelow(true);
    }
  }, [lastMessageId, messages.length, peerTyping]);

  // A list that just appeared (room loaded, or the call chat shown again) opens
  // at the newest message, and stays pinned there while the layout settles: the
  // list or its content can change size after the scroll (the call panel sizing
  // itself, fonts, reaction rows), which left the newest messages just below the edge.
  useLayoutEffect(() => {
    const list = listEl;
    if (!list) return;
    nearBottomRef.current = true;
    setUnseenBelow(false);
    list.scrollTop = list.scrollHeight;
    if (typeof ResizeObserver === 'undefined') return;
    const pin = () => {
      if (nearBottomRef.current) list.scrollTop = list.scrollHeight;
    };
    const ro = new ResizeObserver(pin);
    ro.observe(list);
    for (const child of Array.from(list.children)) ro.observe(child);
    const mo = new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach((n) => n instanceof Element && ro.observe(n));
    });
    mo.observe(list, { childList: true });
    void document.fonts?.ready.then(pin);
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [listEl, historyReady]);

  function onListScroll() {
    const list = listRef.current;
    if (!list) return;
    // Stop following only when the reader scrolls up. The list's own smooth
    // scroll towards a new message passed through "far from the bottom" and
    // used to switch following off, so quick replies were left below the fold.
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distance < 96) {
      nearBottomRef.current = true;
      setUnseenBelow(false);
    } else if (list.scrollTop < lastScrollTopRef.current - 2) {
      nearBottomRef.current = false;
    }
    lastScrollTopRef.current = list.scrollTop;
  }

  function jumpToLatest() {
    const list = listRef.current;
    if (!list) return;
    nearBottomRef.current = true;
    setUnseenBelow(false);
    list.scrollTo({ top: list.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  // Mark-read when the tab is visible (even if media chat panel is collapsed).
  useEffect(() => {
    if (!sessionId || !roomId || messages.length === 0) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const latestPeer = [...messages].reverse().find((m) => !isSelfId(m.senderSessionId));
    if (!latestPeer || latestPeer.id === lastReadSent.current) return;
    lastReadSent.current = latestPeer.id;
    void api
      .markRead(roomId, latestPeer.id)
      .then((res) => setReads(res.reads))
      .catch(() => {
        /* ignore */
      });
  }, [messages, sessionId, roomId, chatOpen]);

  useEffect(() => {
    function onVis() {
      if (document.visibilityState !== 'visible') return;
      if (!sessionId || !roomId) return;
      setMessages((prev) => {
        const latestPeer = [...prev].reverse().find((m) => !isSelfId(m.senderSessionId));
        if (latestPeer && latestPeer.id !== lastReadSent.current) {
          lastReadSent.current = latestPeer.id;
          void api
            .markRead(roomId, latestPeer.id)
            .then((res) => setReads(res.reads))
            .catch(() => {
              /* ignore */
            });
        }
        return prev;
      });
    }
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [sessionId, roomId]);

  function sendTyping(typing: boolean) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    amTyping.current = typing;
    ws.send(JSON.stringify({ type: 'typing', payload: { roomId, typing } }));
  }

  function onTextChange(value: string) {
    setText(value);
    if (!value.trim()) {
      if (amTyping.current) sendTyping(false);
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
      return;
    }
    if (!amTyping.current) sendTyping(true);
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => sendTyping(false), 1200);
  }

  function onSend(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    // An empty box does nothing, so a second Enter can no longer post the same
    // text twice: the box is cleared the moment a message is taken.
    if (!body) return;
    const editTarget = editing;
    const replyTarget = replyTo;
    // Clear at once. The box used to empty only when the server answered, so text
    // typed meanwhile was glued onto this message or wiped.
    if (editTarget) {
      setText(draftBeforeEditRef.current);
      draftBeforeEditRef.current = '';
    } else {
      setText('');
    }
    if (amTyping.current) sendTyping(false);
    if (editTarget) {
      setEditing(null);
    } else {
      setReplyTo(null);
      forceScrollRef.current = true;
    }
    // Queue behind earlier sends: the next message is never blocked or lost while
    // one is still on its way, and they arrive in the order they were written.
    sendChainRef.current = sendChainRef.current.then(async () => {
      try {
        if (editTarget) {
          const msg = normalizeMessage(await api.editMessage(editTarget.id, body));
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
        } else {
          const msg = normalizeMessage(await api.sendMessage(roomId, body, replyTarget?.id));
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        }
        setError(null);
      } catch (err) {
        // Give the text (and the edit / reply it belonged to) back. A failed edit
        // reopens the edit and parks whatever is in the box as the draft again.
        if (editTarget) {
          setText((current) => {
            draftBeforeEditRef.current = current;
            return body;
          });
          setEditing((cur) => cur ?? editTarget);
        } else {
          setText((current) => (current ? current : body));
          if (replyTarget) setReplyTo((cur) => cur ?? replyTarget);
        }
        handleActionError(err, editTarget ? 'Could not save the edit' : 'Could not send');
      }
    });
  }

  /** Errors from message actions: gone room / lost membership get their own screens. */
  function handleActionError(err: unknown, fallback: string) {
    const status = errorStatus(err);
    const code = errorCode(err);
    const msg = friendlyError(err, fallback);
    const roomGone = code
      ? code === ErrorCodes.ROOM_NOT_FOUND || code === ErrorCodes.ROOM_EXPIRED
      : status === 404 && /room/i.test(msg);
    if (roomGone) {
      setRoomGone(true);
      return;
    }
    if (status === 403) {
      // Membership is gone (a purged room answers 403 before 404): the join form
      // tries again, and a 404 there shows the ended screen.
      setRoom(null);
      setMemberOf('');
      setNeedsJoin(true);
      setError('Join this room to continue.');
      return;
    }
    setError(msg);
  }

  function blurMenu() {
    setMenuId(null);
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }

  async function onReact(messageId: string, emoji: string) {
    blurMenu();
    try {
      const res = await api.reactMessage(messageId, emoji);
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, reactions: res.reactions } : m)),
      );
    } catch (err) {
      handleActionError(err, 'Could not react');
    }
  }

  function requestDelete(messageId: string) {
    deleteReturnRef.current =
      listRef.current?.querySelector<HTMLElement>(`[data-msg-id="${messageId}"] .bubble`) ?? null;
    blurMenu();
    setPendingDeleteId(messageId);
  }

  async function confirmDelete() {
    if (!pendingDeleteId) return;
    const messageId = pendingDeleteId;
    setPendingDeleteId(null);
    try {
      const msg = normalizeMessage(await api.deleteMessage(messageId));
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
    } catch (err) {
      handleActionError(err, 'Could not delete');
    }
  }

  function focusComposer() {
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function startEdit(m: MessageView) {
    blurMenu();
    // Keep an unsent draft: editing used to overwrite it for good.
    if (!editing) draftBeforeEditRef.current = text;
    setEditing(m);
    setReplyTo(null);
    setText(m.content);
    focusComposer();
  }

  function startReply(m: MessageView) {
    blurMenu();
    setReplyTo(m);
    setEditing(null);
    focusComposer();
  }

  function cancelComposerContext() {
    if (editing) {
      setText(draftBeforeEditRef.current);
      draftBeforeEditRef.current = '';
    }
    setReplyTo(null);
    setEditing(null);
  }

  /** Copies the room link; true when it reached the clipboard. */
  async function copyRoomLink(): Promise<boolean> {
    if (!roomId) return false;
    const base = `${window.location.origin}/chat/${encodeURIComponent(roomId)}`;
    const link =
      room?.type === 'private' && inviteCode
        ? `${base}#invite=${encodeURIComponent(inviteCode)}`
        : base;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      return true;
    } catch {
      setError('Could not copy the link. Copy it from the address bar instead.');
      return false;
    }
  }

  /** Leaves the room (the hold-to-leave button is the confirmation). */
  async function leave() {
    leavingBeacon.current = true;
    try {
      await api.leaveRoom(roomId);
    } catch {
      // ignore
    }
    clearRoomSession(roomId);
    navigate('/lobby');
  }

  async function findNextMatch() {
    leavingBeacon.current = true;
    clearRoomSession(roomId);
    try {
      // Must finish leave before autoNext enqueue, or match reuses this room.
      await api.leaveRoom(roomId);
    } catch {
      // ignore
    }
    navigate('/match', {
      state: { autoNext: true, mode, nickname, leftRoomId: roomId },
    });
  }

  // Match rooms: if the other person has no live connection for a while (closed
  // the tab, never arrived), say so instead of leaving you waiting on a ghost.
  const roomType = room?.type;
  useEffect(() => {
    if (roomType !== 'match' || peerLeft) {
      setPeerAbsent(false);
      return;
    }
    if (online >= 2) {
      setPeerAbsent(false);
      return;
    }
    const t = window.setTimeout(() => setPeerAbsent(true), 30_000);
    return () => window.clearTimeout(t);
  }, [roomType, online, peerLeft]);

  const roomLabel =
    room?.type === 'match'
      ? peerNickname
        ? `Match with ${peerNickname}`
        : peerLeft
          ? 'Match ended'
          : 'Match'
      : room?.slug
        ? `#${room.slug}`
        : 'Room';

  const isDirect = room?.type === 'match' || room?.type === 'private';
  const isMedia = mode === 'voice' || mode === 'video';
  const isMatch = room?.type === 'match';
  const modeLabel = mode === 'video' ? 'Video room' : mode === 'voice' ? 'Voice room' : null;

  useEffect(() => {
    if (peerLeft || !isMedia) setMediaCallLive(false);
  }, [peerLeft, isMedia]);

  // Show widget only while joining or bootstrapping a session challenge — not mid-room.
  const showTurnstile = Boolean(turnstile.required && (needsJoin || (bootstrapping && !room)));
  // One element whether shown or not (hidden while not needed, so ensureChatSession
  // can still takeToken on cold start): swapping elements re-rendered the widget.
  const turnstileSlot = (
    <>
      <div
        className="turnstile-slot"
        ref={turnstile.hostRef}
        hidden={!showTurnstile}
        aria-hidden={showTurnstile ? undefined : true}
        aria-label={showTurnstile ? 'Human verification' : undefined}
      />
      {showTurnstile && turnstile.error ? <p className="error">{turnstile.error}</p> : null}
    </>
  );

  const canShareRoom = room?.type === 'public' || room?.type === 'private';

  const inviteBlock =
    room?.type === 'private' && inviteCode ? (
      <div className="invite-row">
        <span className="invite-code">Invite {inviteCode}</span>
      </div>
    ) : null;

  const copyLinkBtn = canShareRoom ? (
    <button type="button" className="btn btn-ghost btn-compact" onClick={() => void copyRoomLink()}>
      {copied ? 'Copied' : 'Copy link'}
    </button>
  ) : null;

  const whoBlock =
    members.length > 0 ? (
      <WhoHere members={members} online={online} isSelf={(m) => isSelfMember(m, nickname)} />
    ) : null;

  const peerLeftBanner =
    peerLeft && isDirect ? (
      <PeerLeftBanner
        isMatch={isMatch}
        onFindNext={() => void findNextMatch()}
        onLeave={() => void leave()}
      />
    ) : null;

  const peerAbsentBanner =
    isMatch && peerAbsent && !peerLeft ? (
      <PeerAbsentBanner onFindNext={() => void findNextMatch()} />
    ) : null;

  const messagesBlock = (
    // The list's top edge blurs older messages as they scroll away (React Bits
    // Gradual Blur). It sits on a frame around the list, not in it, so it stays put.
    <div className="messages-frame">
      <div
        className="messages"
        ref={attachList}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Messages"
        onScroll={onListScroll}
        onClick={() => setMenuId(null)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && menuId) {
            e.stopPropagation();
            const bubble = listRef.current?.querySelector<HTMLElement>(
              `[data-msg-id="${menuId}"] .bubble`,
            );
            setMenuId(null);
            bubble?.focus();
          }
        }}
      >
        {hasMore ? (
          <div className="load-earlier">
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              disabled={loadingMore}
              onClick={() => void loadEarlier()}
            >
              {loadingMore ? 'Loading…' : 'Load earlier'}
            </button>
          </div>
        ) : null}
        {messages.length === 0 ? (
          historyReady ? (
            <div className="empty-state">
              {room?.type === 'private' && inviteCode ? (
                <inviteTicket.Piece fallback={null} code={inviteCode} onCopy={copyRoomLink} />
              ) : (
                <p>No messages yet.</p>
              )}
              <p className="muted">Say something — it disappears after {expiresLabel}.</p>
            </div>
          ) : (
            <div className="empty-state" aria-busy="true">
              <p className="muted">Loading messages…</p>
            </div>
          )
        ) : (
          messages.map((m, index) => {
            const mine = isSelfId(m.senderSessionId);
            const seen = peerSeenCount(m, isSelfId, reads);
            const open = menuId === m.id;
            const stacked = index > 0 && messages[index - 1]?.senderSessionId === m.senderSessionId;
            const stackEnd =
              index === messages.length - 1 ||
              messages[index + 1]?.senderSessionId !== m.senderSessionId;
            const stackStart = !stacked && !stackEnd;
            return (
              <MessageItem
                key={m.id}
                m={m}
                mine={mine}
                seen={seen}
                open={open}
                placement={{ stacked, stackStart, stackEnd }}
                isDirect={isDirect}
                isSelfId={isSelfId}
                onToggleMenu={() => setMenuId((cur) => (cur === m.id ? null : m.id))}
                onOpenMenu={() => setMenuId(m.id)}
                onReact={(emoji) => void onReact(m.id, emoji)}
                onReply={() => startReply(m)}
                onEdit={() => startEdit(m)}
                onDelete={() => requestDelete(m.id)}
                shredding={shredding.has(m.id)}
                onShredDone={() => dropMessage(m.id)}
              />
            );
          })
        )}
        {peerTyping ? (
          <div className="typing-indicator" aria-live="polite">
            <span className="typing-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {(() => {
              const who =
                peerNickname || members.find((m) => !isSelfMember(m, nickname))?.nickname || '';
              return who ? `${who} is typing…` : 'Someone is typing…';
            })()}
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>
      <GradualBlur position="top" target="parent" height="2.5rem" strength={3.5} layers={4} />
      {unseenBelow ? (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          <ArrowDown aria-hidden="true" strokeWidth={iconStroke} />
          New messages
        </button>
      ) : null}
    </div>
  );

  const composerBlock = (
    <Composer
      error={error}
      editing={editing}
      replyTo={replyTo}
      text={text}
      disabled={peerLeft && isDirect}
      inputRef={composerRef}
      onTextChange={onTextChange}
      onSubmit={onSend}
      onCancelContext={cancelComposerContext}
      onBlur={() => {
        if (amTyping.current) sendTyping(false);
      }}
    />
  );

  const deleteModal = (
    <ConfirmDialog
      open={Boolean(pendingDeleteId)}
      title="Delete message?"
      body={'Everyone in the room will see “This message was deleted”.'}
      confirmLabel="Delete"
      danger
      onCancel={() => setPendingDeleteId(null)}
      onConfirm={() => void confirmDelete()}
      returnFocusTo={() => deleteReturnRef.current}
    />
  );

  const connBanner = connToast ? (
    <div
      className={`conn-toast${isMedia && mediaCallLive ? ' soft' : ''}`.trim()}
      aria-live="polite"
    >
      {connToast}
    </div>
  ) : null;

  if (roomGone) {
    return (
      <main className="panel join-gate">
        <h1>This room has ended</h1>
        <p className="muted join-gate-lead">
          It expired or was closed. Messages here are gone, as promised.
        </p>
        <div className="cta-row">
          <button type="button" className="btn btn-primary" onClick={() => navigate('/lobby')}>
            Back to lobby
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/match')}>
            Random match
          </button>
        </div>
      </main>
    );
  }

  if ((needsJoin || (error && !room)) && !room) {
    return (
      <main className="panel join-gate">
        <h1>{needsJoin ? 'Enter room' : 'Can\u2019t open room'}</h1>
        <p className="muted join-gate-lead">
          {needsJoin
            ? turnstile.required
              ? 'Complete verification, then join with a nickname. Private rooms also need the invite code.'
              : 'Join with a nickname. Private rooms also need the invite code.'
            : null}
        </p>
        {turnstileSlot}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {needsJoin ? (
          <form className="join-gate-form" onSubmit={(e) => void submitDeepJoin(e)}>
            <div className="field">
              <label htmlFor="deep-nick">Nickname</label>
              <input
                id="deep-nick"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={MAX_NICKNAME_LENGTH}
                autoComplete="off"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="deep-invite">Invite code (private rooms)</label>
              <input
                id="deep-invite"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                placeholder="Optional for public rooms"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="cta-row">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={joining || (turnstile.required && !turnstile.ready)}
              >
                {joining ? 'Joining…' : 'Enter room'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => navigate('/lobby')}>
                Back to lobby
              </button>
            </div>
          </form>
        ) : (
          <div className="cta-row">
            <button type="button" className="btn btn-primary" onClick={() => navigate('/lobby')}>
              Back to lobby
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => navigate('/match')}>
              Random match
            </button>
          </div>
        )}
      </main>
    );
  }

  if (bootstrapping && !room) {
    return (
      <main className="panel join-gate">
        <h1>Opening room…</h1>
        <p className="muted join-gate-lead">
          {turnstile.required ? 'Verifying, then connecting you.' : 'Connecting you…'}
        </p>
        {turnstileSlot}
      </main>
    );
  }

  if (isMedia) {
    return (
      <main className={`panel media-room mode-${mode}`}>
        {connBanner}
        <div className="media-room-bar">
          <div>
            <h1>{roomLabel}</h1>
            <p className="muted">
              {modeLabel}
              {online > 0 && online !== members.length ? ` · ${online} online` : ''}
              {room?.type && room.type !== 'match' ? ` · ${room.type}` : ''}
              <span className="media-ttl"> · chat disappears after {expiresLabel}</span>
            </p>
            {inviteBlock}
            {whoBlock}
          </div>
          <div className="media-room-bar-actions">
            {isMatch && !peerLeft ? (
              <button
                type="button"
                className="btn btn-ghost btn-compact"
                onClick={() => void findNextMatch()}
              >
                Find next
              </button>
            ) : null}
            {copyLinkBtn}
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              onClick={() => setChatOpen((v) => !v)}
              aria-expanded={chatOpen}
            >
              {chatOpen ? 'Hide chat' : 'Show chat'}
            </button>
            {/* Leave lives on the media dock only — avoids dual Leave / Leave call. */}
            {peerLeft ? <HoldToLeave onLeave={() => leave()} /> : null}
          </div>
        </div>

        {peerLeftBanner}
        {peerAbsentBanner}

        <div className={`media-room-body ${chatOpen ? 'chat-open' : 'chat-closed'}`.trim()}>
          {!peerLeft ? (
            <MediaCall
              roomId={roomId}
              mode={mode}
              nickname={nickname}
              peerNickname={peerNickname || undefined}
              // A first-time join needs a verification token (the server asks for one).
              ensureMember={() => joinViaLink({ requireTurnstile: true })}
              onLeave={() => leave()}
              onCallStateChange={(s) =>
                setMediaCallLive(s === 'live' || s === 'reconnecting' || s === 'connecting')
              }
            />
          ) : (
            <div className={`media-stage mode-${mode} state-idle`}>
              <div className="media-waiting-hint">{isMatch ? 'Match ended' : 'Peer left'}</div>
            </div>
          )}
          {chatOpen ? (
            <aside className="media-chat" aria-label="Room chat">
              {messagesBlock}
              {composerBlock}
            </aside>
          ) : null}
        </div>
        {deleteModal}
      </main>
    );
  }

  return (
    <main className="panel chat-layout">
      {/* Host kept mounted (hidden) for rare session recreate; no visible challenge in-room. */}
      <div className="turnstile-slot" ref={turnstile.hostRef} hidden aria-hidden="true" />
      {connBanner}
      <div className="chat-meta">
        <div>
          <h1>{roomLabel}</h1>
          <p className="muted">
            Messages disappear after {expiresLabel}
            {online > 0 && online !== members.length ? ` · ${online} online` : ''}
            {room?.type && room.type !== 'match' ? ` · ${room.type}` : ''}
          </p>
          {inviteBlock}
          {whoBlock}
        </div>
        <div className="cta-row">
          {isMatch && !peerLeft ? (
            <button className="btn btn-ghost" onClick={() => void findNextMatch()}>
              Find next
            </button>
          ) : null}
          {copyLinkBtn}
          <HoldToLeave onLeave={() => leave()} />
        </div>
      </div>

      {peerLeftBanner}
      {peerAbsentBanner}
      {messagesBlock}
      {composerBlock}
      {deleteModal}
    </main>
  );
}
