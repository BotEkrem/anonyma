import { copyForCode, friendlyError as humanizeError } from './errors';
import { ErrorCodes } from '@anonyma/contracts';

// API views shared with the services (packages/shared/src/contracts.ts).
export type {
  MatchMode,
  MatchPairView,
  MessageView,
  RoomMemberView,
  RoomReadMap,
  RoomView,
} from '@anonyma/contracts';
export { REACTION_EMOJIS } from '@anonyma/contracts';
import type {
  MatchMode,
  MatchPairView,
  MessageView,
  RoomMemberView,
  RoomReadMap,
  RoomView,
} from '@anonyma/contracts';

export interface PublicConfig {
  turnstileSiteKey: string;
  turnstileRequired: boolean;
  wsUrl: string;
  messageTtlSeconds: number;
  voiceEnabled?: boolean;
  /** Env configured; may still be true when LiveKit is briefly unreachable. */
  voiceConfigured?: boolean;
}

function parseApiError(raw: string, fallback: string): { message: string; code?: string } {
  const text = raw.trim();
  if (!text) return { message: fallback };
  let extracted = text;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as {
      message?: unknown;
      error?: unknown;
      statusCode?: unknown;
      code?: unknown;
    };
    if (typeof parsed.code === 'string' && parsed.code) code = parsed.code;
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      extracted = parsed.message.trim();
    } else if (Array.isArray(parsed.message) && parsed.message.length) {
      extracted = parsed.message.map(String).join('; ');
    } else if (typeof parsed.error === 'string' && parsed.error.trim()) {
      extracted = parsed.error.trim();
    }
  } catch {
    // plain text
  }
  if (extracted.startsWith('<!DOCTYPE') || extracted.startsWith('<html'))
    return { message: fallback, code };
  const clipped = extracted.length > 180 ? `${extracted.slice(0, 177)}…` : extracted;
  return { message: copyForCode(code) ?? humanizeError(clipped, fallback), code };
}

/** A failed API call: user-facing message, the HTTP status and the server's error code. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Stable code from the server (errorCodes.ts); absent from older servers. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorStatus(err: unknown): number {
  return err instanceof ApiError ? err.status : 0;
}

export function errorCode(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    const fallback =
      res.status === 429
        ? 'Too many attempts. Wait a moment and try again.'
        : res.statusText || 'Request failed';
    const { message, code } = parseApiError(text, fallback);
    // Only a session the server rejected is dropped (uncoded 401s are sessions too).
    if (
      res.status === 401 &&
      (code === undefined ||
        code === ErrorCodes.SESSION_INVALID ||
        code === ErrorCodes.SESSION_REQUIRED)
    ) {
      forgetSession();
    }
    throw new ApiError(message, res.status, code);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export const api = {
  config: () => request<PublicConfig>('/api/config'),
  createSession: async (turnstileToken?: string) => {
    const out = await request<{ session: SessionView }>('/api/session', {
      method: 'POST',
      body: JSON.stringify({ turnstileToken }),
    });
    rememberSession(out.session);
    return out;
  },
  getSession: () => request<SessionView>('/api/session'),
  deleteSession: async () => {
    try {
      await request<void>('/api/session', { method: 'DELETE' });
    } finally {
      forgetSession();
    }
  },
  listRooms: () => request<RoomView[]>('/api/rooms'),
  getRoom: (roomId: string) => request<RoomView>(`/api/rooms/${encodeURIComponent(roomId)}`),
  getRoomInvite: (roomId: string) =>
    request<{ inviteCode: string }>(`/api/rooms/${encodeURIComponent(roomId)}/invite`),
  listMembers: (roomId: string) =>
    request<RoomMemberView[]>(`/api/rooms/${encodeURIComponent(roomId)}/members`),
  createRoom: (body: {
    type: 'public' | 'private';
    mode: MatchMode;
    nickname: string;
    turnstileToken?: string;
  }) =>
    request<{ room: RoomView; inviteCode?: string }>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  joinRoom: (body: {
    nickname: string;
    roomId?: string;
    inviteCode?: string;
    slug?: string;
    turnstileToken?: string;
  }) => request<RoomView>('/api/rooms/join', { method: 'POST', body: JSON.stringify(body) }),
  leaveRoom: (roomId: string) =>
    request<{ ok: boolean }>('/api/rooms/leave', {
      method: 'POST',
      body: JSON.stringify({ roomId }),
    }),
  sendMessage: (roomId: string, content: string, replyToId?: string) =>
    request<MessageView>('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ roomId, content, replyToId }),
    }),
  listMessages: (roomId: string, opts?: { limit?: number; before?: string }) => {
    const q = new URLSearchParams({ roomId });
    if (opts?.limit) q.set('limit', String(opts.limit));
    if (opts?.before) q.set('before', opts.before);
    return request<MessageView[]>(`/api/messages?${q.toString()}`);
  },
  editMessage: (messageId: string, content: string) =>
    request<MessageView>(`/api/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }),
  deleteMessage: (messageId: string) =>
    request<MessageView>(`/api/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    }),
  reactMessage: (messageId: string, emoji: string) =>
    request<{ roomId: string; messageId: string; reactions: Record<string, string[]> }>(
      `/api/messages/${encodeURIComponent(messageId)}/reactions`,
      { method: 'POST', body: JSON.stringify({ emoji }) },
    ),
  markRead: (roomId: string, messageId: string) =>
    request<{ roomId: string; sessionId: string; messageId: string; reads: RoomReadMap }>(
      `/api/rooms/${encodeURIComponent(roomId)}/read`,
      { method: 'POST', body: JSON.stringify({ messageId }) },
    ),
  listReads: (roomId: string) =>
    request<RoomReadMap>(`/api/rooms/${encodeURIComponent(roomId)}/reads`),
  enqueueMatch: (nickname: string, mode: MatchMode, next?: boolean) =>
    request<{ status: 'queued' | 'paired'; pair?: MatchPairView }>('/api/match', {
      method: 'POST',
      body: JSON.stringify({ nickname, mode, next }),
    }),
  matchStatus: () =>
    request<{ status: 'idle' | 'queued' | 'paired'; pair?: MatchPairView; mode?: MatchMode }>(
      '/api/match/status',
    ),
  cancelMatch: () => request<{ ok: boolean }>('/api/match/cancel', { method: 'POST', body: '{}' }),
  wsTicket: (roomId: string) =>
    request<{ ticket: string; expiresIn: number }>('/api/ws-ticket', {
      method: 'POST',
      body: JSON.stringify({ roomId }),
    }),
  joinVoice: (roomId: string, _nickname?: string) =>
    request<{ url: string; token: string; roomName: string }>(
      `/api/rooms/${encodeURIComponent(roomId)}/voice`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
};

export interface SessionView {
  id: string;
  expiresAt?: string;
}

/*
 * ONE ANSWER TO "IS THERE A SESSION?" PER PAGE VIEW.
 *
 * The header, the page and ensureSession each asked on their own, so one page
 * load sent the same GET three or four times; and "no session" came back as a
 * 401 that every browser prints as an error. Now concurrent askers share one
 * request, the answer is kept a few seconds, and the probe route answers 200
 * with { session: null } when there is none.
 */
const SESSION_TTL_MS = 5_000;
let sessionCache: { at: number; value: SessionView | null } | null = null;
let sessionInflight: Promise<SessionView | null> | null = null;

function rememberSession(value: SessionView | null): void {
  sessionCache = { at: Date.now(), value };
}

function forgetSession(): void {
  sessionCache = null;
}

async function probeSession(): Promise<SessionView | null> {
  const res = await fetch('/api/session/current', { credentials: 'include' });
  if (res.ok) return ((await res.json()) as { session: SessionView | null }).session ?? null;
  if (res.status === 404) {
    // A gateway older than this page: ask the old way.
    return api.getSession().catch(() => null);
  }
  const { message, code } = parseApiError(await res.text(), res.statusText || 'Request failed');
  throw new ApiError(message, res.status, code);
}

/** The current session, or null. Shared and briefly cached. */
export function currentSession(fresh = false): Promise<SessionView | null> {
  if (!fresh && sessionCache && Date.now() - sessionCache.at < SESSION_TTL_MS) {
    return Promise.resolve(sessionCache.value);
  }
  if (!sessionInflight) {
    sessionInflight = probeSession()
      .then((value) => {
        rememberSession(value);
        return value;
      })
      .finally(() => {
        sessionInflight = null;
      });
  }
  return sessionInflight;
}

/** The current session, made with this token when there is none. */
export async function ensureSession(turnstileToken?: string): Promise<SessionView> {
  const existing = await currentSession();
  if (existing) return existing;
  return (await api.createSession(turnstileToken)).session;
}

let cachedConfig: PublicConfig | null = null;
let cachedConfigAt = 0;
let configInflight: Promise<PublicConfig> | null = null;
const CONFIG_TTL_MS = 60_000;
/** A forced read still reuses an answer this young (pages force on mount). */
const CONFIG_FORCE_REUSE_MS = 5_000;

export type MonitoringPoint = [number, number | null];

export type MonitoringSectionId = 'overview' | 'cluster' | 'gateway' | 'core' | 'realtime';

/** Aggregates only (gateway: /api/monitoring/:section). */
export interface MonitoringSection {
  section: MonitoringSectionId;
  available: boolean;
  generatedAt: number;
  range: { start: number; end: number; step: number };
  stats: Record<string, number | null>;
  lines: Record<string, MonitoringPoint[]>;
  breakdowns: Record<string, Record<string, MonitoringPoint[]>>;
  values: Record<string, Record<string, number>>;
}

export async function getMonitoring(section: MonitoringSectionId): Promise<MonitoringSection> {
  const res = await fetch(`/api/monitoring/${section}`, { credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error(`monitoring ${res.status}`);
  return (await res.json()) as MonitoringSection;
}

/**
 * Public config, shared: concurrent callers wait on one request (the gateway
 * probes LiveKit for every /api/config, so a duplicate is real server work).
 */
export function getPublicConfig(force = false): Promise<PublicConfig> {
  const age = Date.now() - cachedConfigAt;
  if (cachedConfig && age < (force ? CONFIG_FORCE_REUSE_MS : CONFIG_TTL_MS)) {
    return Promise.resolve(cachedConfig);
  }
  if (!configInflight) {
    configInflight = api
      .config()
      .then((cfg) => {
        cachedConfig = cfg;
        cachedConfigAt = Date.now();
        return cfg;
      })
      .finally(() => {
        configInflight = null;
      });
  }
  return configInflight;
}
